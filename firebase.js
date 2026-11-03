const firebaseVersion = '13.1.0';
const firebaseConfig = {
  apiKey: 'AIzaSyCQM3K11jFGUiL8WjAAWTnULICqTzbrsoY',
  authDomain: 'study-app-820dc.firebaseapp.com',
  databaseURL: 'https://study-app-820dc-default-rtdb.firebaseio.com',
  projectId: 'study-app-820dc',
  storageBucket: 'study-app-820dc.firebasestorage.app',
  messagingSenderId: '210283172036',
  appId: '1:210283172036:web:48db939cda2fcb52107991',
};

async function initializeStudyspaceFirebase() {
  try {
    const root = `https://www.gstatic.com/firebasejs/${firebaseVersion}`;
    const [appSdk, authSdk, databaseSdk] = await Promise.all([
      import(`${root}/firebase-app.js`),
      import(`${root}/firebase-auth.js`),
      import(`${root}/firebase-database.js`),
    ]);
    const app = appSdk.initializeApp(firebaseConfig);
    const auth = authSdk.getAuth(app);
    const database = databaseSdk.getDatabase(app, firebaseConfig.databaseURL);
    let initialAuthResolved = false;
    let resolveInitialAuth;
    const initialAuth = new Promise(resolve => { resolveInitialAuth = resolve; });
    authSdk.onAuthStateChanged(auth, user => {
      if (!initialAuthResolved) { initialAuthResolved = true; resolveInitialAuth(user); }
    });
    const profile = user => user ? { id: user.uid, username: user.displayName || user.email || 'Learner', email: user.email || '' } : null;
    const studyRef = uid => databaseSdk.ref(database, `users/${uid}/study`);
    const documentCollection = uid => databaseSdk.ref(database, `users/${uid}/driveDocuments`);
    const documentRef = (uid, documentId) => databaseSdk.ref(database, `users/${uid}/driveDocuments/${documentId}`);
    const documentDataRef = (uid, documentId) => databaseSdk.ref(database, `users/${uid}/driveDocumentData/${documentId}`);
    const signedInUid = async () => {
      await initialAuth;
      if (!auth.currentUser) throw new Error('Sign in to access your imported presentations.');
      return auth.currentUser.uid;
    };

    window.resolveStudyspaceFirebase({
      error: null,
      async currentUser() { await initialAuth; return auth.currentUser; },
      async signInWithGoogle() {
        const provider = new authSdk.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const result = await authSdk.signInWithPopup(auth, provider);
        return { user: profile(result.user) };
      },
      async signOut() { await authSdk.signOut(auth); return { ok: true }; },
      async readStudy(uid) {
        const snapshot = await databaseSdk.get(studyRef(uid));
        return snapshot.exists() ? snapshot.val() : null;
      },
      async writeStudy(uid, study) {
        const value = JSON.parse(JSON.stringify({ ...study, updatedAt: new Date().toISOString() }));
        await databaseSdk.set(studyRef(uid), value);
        return value;
      },
      watchStudy(uid, onChange, onError) {
        return databaseSdk.onValue(studyRef(uid), snapshot => onChange(snapshot.val()), onError);
      },
      async listDriveDocuments() {
        const uid = await signedInUid();
        const snapshot = await databaseSdk.get(documentCollection(uid));
        const documents = snapshot.val() || {};
        return Object.entries(documents).map(([id, value]) => ({ id, ...value }));
      },
      async watchDriveDocuments(uid, onChange, onError) {
        if (!uid || auth.currentUser?.uid !== uid) throw new Error('Sign in to sync imported presentations.');
        return databaseSdk.onValue(documentCollection(uid), snapshot => {
          const documents = snapshot.val() || {};
          onChange(Object.entries(documents).map(([id, value]) => ({ id, ...value })));
        }, onError);
      },
      async getDriveDocument(documentId) {
        const uid = await signedInUid();
        const snapshot = await databaseSdk.get(documentRef(uid, documentId));
        return snapshot.exists() ? { id: snapshot.key, ...snapshot.val() } : null;
      },
      async writeDriveDocument(documentId, value) {
        const uid = await signedInUid();
        const safeValue = JSON.parse(JSON.stringify({ ...value, updatedAt: new Date().toISOString() }));
        await databaseSdk.update(documentRef(uid, documentId), safeValue);
        return safeValue;
      },
      async writeDriveSlideChunks(documentId, chunks) {
        const uid = await signedInUid();
        for (const chunk of chunks) {
          const chunkKey = String(chunk.chunkIndex).padStart(5, '0');
          await databaseSdk.set(databaseSdk.child(documentDataRef(uid, documentId), `slideChunks/${chunkKey}`), JSON.parse(JSON.stringify(chunk)));
        }
      },
      async listDriveSlideChunks(documentId) {
        const uid = await signedInUid();
        const snapshot = await databaseSdk.get(databaseSdk.child(documentDataRef(uid, documentId), 'slideChunks'));
        const chunks = snapshot.val() || {};
        return Object.values(chunks).sort((a, b) => Number(a.chunkIndex) - Number(b.chunkIndex));
      },
      async writeDriveAnalysis(documentId, batchId, value) {
        const uid = await signedInUid();
        const ref = databaseSdk.child(documentDataRef(uid, documentId), `analysisBatches/${batchId}`);
        await databaseSdk.set(ref, JSON.parse(JSON.stringify({ ...value, updatedAt: new Date().toISOString() })));
      },
      async listDriveAnalysis(documentId) {
        const uid = await signedInUid();
        const snapshot = await databaseSdk.get(databaseSdk.child(documentDataRef(uid, documentId), 'analysisBatches'));
        const batches = snapshot.val() || {};
        return Object.values(batches).sort((a, b) => Number(a.batchIndex) - Number(b.batchIndex));
      },
    });
  } catch (error) {
    window.resolveStudyspaceFirebase({ error });
  }
}

initializeStudyspaceFirebase();
