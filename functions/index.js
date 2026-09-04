// ---------------------------------------------------------------------------
// Roshan Bundle Activation -- Cloud Functions (server-side push sender)
//
// The web app (index.html) only ASKS for a push token and SAVES it on the
// logged-in user's record in appdata/users. It cannot send pushes to other
// people's devices by itself -- that has to happen from a trusted server,
// which is what this file is. It watches appdata/bundles for the same
// events the in-app code already reacts to, and sends a real FCM push to
// the right people's saved tokens so they get notified even if their
// phone/app is completely closed.
// ---------------------------------------------------------------------------

const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Must match ASSIGN_WAIT_MS in index.html.
const ASSIGN_WAIT_MS = 40 * 1000;

function findAssignedManager(users, ntoUsername){
  const ntoUser = users.find(u => u.username === ntoUsername && u.role === 'nto');
  if(!ntoUser || !ntoUser.createdBy) return null;
  const creator = users.find(u => u.username === ntoUser.createdBy && u.role === 'manager');
  return creator ? creator.username : null;
}

function isBundleClaimableByManager(users, b, managerUsername){
  if(b.status === 'approved' || b.status === 'rejected' || b.status === 'deactivated') return true;
  const assignedMgr = findAssignedManager(users, b.ntoUsername);
  if(!assignedMgr) return true;
  const startedAt = b.waitStartAt || b.createdAt || 0;
  if(Date.now() - startedAt >= ASSIGN_WAIT_MS) return true;
  return managerUsername === assignedMgr;
}

function tokensFor(users, usernames){
  const set = new Set();
  users.forEach(u => {
    if(usernames.includes(u.username) && Array.isArray(u.fcmTokens)){
      u.fcmTokens.forEach(t => set.add(t));
    }
  });
  return Array.from(set);
}

async function removeTokens(badTokens){
  const ref = db.collection('appdata').doc('users');
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if(!snap.exists) return;
    const list = snap.data().list || [];
    let changed = false;
    list.forEach(u => {
      if(Array.isArray(u.fcmTokens)){
        const filtered = u.fcmTokens.filter(t => !badTokens.includes(t));
        if(filtered.length !== u.fcmTokens.length){ u.fcmTokens = filtered; changed = true; }
      }
    });
    if(changed) tx.set(ref, {list}, {merge:true});
  });
}

async function sendPush(tokens, title, body, data){
  if(!tokens.length) return;
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {title, body},
    data: data || {},
    webpush: {notification: {icon: 'icon-192.png', badge: 'icon-192.png'}}
  });
  const bad = [];
  res.responses.forEach((r, i) => {
    if(!r.success){
      const code = r.error && r.error.code;
      if(code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token'){
        bad.push(tokens[i]);
      }
    }
  });
  if(bad.length) await removeTokens(bad);
}

// Fires on every write to appdata/bundles. Handles:
//  - a new submit / resubmit -> push the manager(s) who can currently claim
//    it, plus every admin.
//  - a status flip to approved/rejected -> push the NTO who submitted it.
exports.onBundlesWrite = onDocumentWritten('appdata/bundles', async (event) => {
  const beforeList = (event.data.before.exists && event.data.before.data().list) || [];
  const afterList = (event.data.after.exists && event.data.after.data().list) || [];
  if(!afterList.length) return;

  const usersSnap = await db.collection('appdata').doc('users').get();
  const users = (usersSnap.exists && usersSnap.data().list) || [];
  if(!users.length) return;

  const beforeMap = {};
  beforeList.forEach(b => { beforeMap[b.id] = b; });

  for(const b of afterList){
    const prev = beforeMap[b.id];
    const prevStatus = prev ? prev.status : undefined;

    if((b.status === 'pending' || b.status === 'resubmit') && prevStatus !== b.status){
      const managers = users
        .filter(u => u.role === 'manager' && u.status !== 'disabled' && isBundleClaimableByManager(users, b, u.username))
        .map(u => u.username);
      const admins = users.filter(u => u.role === 'admin').map(u => u.username);
      const tokens = tokensFor(users, managers.concat(admins));
      await sendPush(tokens, 'نوی بنډل راغی', (b.ntoUsername || '') + ' یو بنډل (' + (b.field2 || '') + ') ولیږه.', {type: 'new_bundle', id: String(b.id)});
    }

    if(prev && prevStatus !== b.status && (b.status === 'approved' || b.status === 'rejected')){
      const ntoTokens = tokensFor(users, [b.ntoUsername]);
      await sendPush(
        ntoTokens,
        b.status === 'approved' ? 'ستاسو بنډل فعاله شو' : 'ستاسو بنډل رد شو',
        (b.field2 || '') + ' — ' + (b.comment || ''),
        {type: 'status_change', id: String(b.id)}
      );
    }
  }
});

// Runs every minute. A bundle opening up to every manager once the 40s
// assignment window elapses involves no Firestore write of its own (nothing
// changes except "time has passed"), so onBundlesWrite above can never catch
// it -- this scheduled check is what handles that case for push. In-app
// notifications for this event still fire instantly while the app is open;
// this only covers the closed/backgrounded case, and can lag up to ~1 minute.
exports.escalateStaleAssignments = onSchedule('every 1 minutes', async () => {
  const usersSnap = await db.collection('appdata').doc('users').get();
  const users = (usersSnap.exists && usersSnap.data().list) || [];
  if(!users.length) return;

  const bundlesRef = db.collection('appdata').doc('bundles');
  const snap = await bundlesRef.get();
  if(!snap.exists) return;
  const list = snap.data().list || [];
  const now = Date.now();
  let changed = false;
  const pushes = [];

  list.forEach(b => {
    if(b.status !== 'pending' && b.status !== 'resubmit') return;
    if(b.escalatedNotified) return;
    const assignedMgr = findAssignedManager(users, b.ntoUsername);
    if(!assignedMgr) return; // was open to everyone from the start
    const startedAt = b.waitStartAt || b.createdAt || 0;
    if(now - startedAt < ASSIGN_WAIT_MS) return; // window hasn't elapsed yet
    b.escalatedNotified = true;
    changed = true;
    const otherManagers = users
      .filter(u => u.role === 'manager' && u.status !== 'disabled' && u.username !== assignedMgr)
      .map(u => u.username);
    pushes.push({tokens: tokensFor(users, otherManagers), b});
  });

  if(changed) await bundlesRef.set({list}, {merge: true});
  for(const p of pushes){
    await sendPush(p.tokens, 'یو بنډل اوس تاسو ته هم خلاص دی', (p.b.ntoUsername || '') + ' — (' + (p.b.field2 || '') + ')', {type: 'escalation', id: String(p.b.id)});
  }
});
