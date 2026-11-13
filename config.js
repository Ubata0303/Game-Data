// ============================================================
// Firebase 設定
// ------------------------------------------------------------
// null のままだと「ローカルモード」で動きます
//   → 同じPC・同じブラウザの複数タブ間だけで同期（お試し用）
// Firebase のプロジェクトを作成したら、下の例のように設定を貼り付けると
//   → PC・タブレット間でリアルタイム共有できるようになります
//   （手順は README.md を参照）
// ============================================================
window.FIREBASE_CONFIG = null;

/* 例:
window.FIREBASE_CONFIG = {
  apiKey: "AIza....",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxx"
};
*/
