# 🏈 Football Data Live

アメフトの試合中に、複数人（3人くらい）で同時にプレーデータを入力・共有するWebアプリです。

## 入力項目と仕様
- **Quarter**: 手打ち（`1`〜`4` / `OT`）。`ot` と小文字で打っても自動で `OT` に変換
- **Series**: 手打ち（`1`〜`99`）
- **Hash**: ボタン選択（`L` / `M` / `R`）
- **Ball On**: 手打ち（敵陣エンドラインから `1`〜`99` yd）
- **Down & Distance**: `[Down] - [Dist]` の2マス手打ち。Down（1〜4）を入力すると自動で Dist 入力欄へフォーカス移動
- **Personnel**: 手打ち（数字キーボード対応・過去の入力履歴チップ付き）
- **OFF Formation**: 手打ち（単語の先頭が自動で大文字化）
- **Play**: 手打ち（単語の先頭が大文字化、`RPO` や `PAP` は自動で大文字化）
- **Def Sign**: 手打ち（単語の先頭が自動で大文字化）

---

## 使い方
### 1. 担当の切り替え
入力画面上部の「担当」ボタンで、自分の役割を選択します（端末ごとに記憶されます）。
| 担当 | 入力する項目 | 行の追加・削除 |
|---|---|---|
| **状況** | Quarter / Series / Hash / Ball On / Down & Distance | ○ |
| **オフェンス** | Personnel / OFF Formation / Play | ×（自動で最新プレーに切り替わる） |
| **Def Sign** | Def Sign | ×（自動で最新プレーに切り替わる） |
| **全項目** | すべて（1人で入力するとき・後からの修正用） | ○ |

※ 担当を選択すると、自分の担当項目だけが大きく押しやすいサイズで表示され、一覧表でも自分の列がハイライトされます。

### 2. 操作の流れ
- **「＋ 次のプレー」**: 状況担当が行を追加。QuarterとSeriesを引き継ぎます。
- **「＋ 新シリーズ」**: Seriesを+1し、1st & 10で新しい行を追加。
- **「最新プレーを追従」**: ONの場合、状況担当が次のプレーを追加すると、全員の画面が自動で最新行に切り替わります（入力中は作業が終わるまで待機）。
- **「← 試合一覧」**: 画面左上の戻るボタンからいつでもホーム画面に戻れます（データは自動保存されます）。
- **オフライン耐性**: 電波が一時的に切れてもローカルに一時保存され、再接続時に自動送信されます（⏳マーク＝未送信）。
- **「CSV書き出し」**: Excelでそのまま開ける形式（UTF-8 with BOM）でダウンロードできます。

---

## まずはお試し（ローカルモード）
1. `index.html` をブラウザ（Chrome等）で開く
2. 同じ `index.html` を別のタブやウィンドウで開くと、複数人での同時入力を1台のPCで体験できます。

※ ローカルモードは **同一ブラウザ内のみ** の同期です。

---

## 複数端末（PC・タブレット）でリアルタイム共有する手順
1. [Firebase Console](https://console.firebase.google.com/) で新規プロジェクトを作成（無料プラン Spark）
2. **Firestore Database** を作成（ロケーション: `asia-northeast1`（東京）推奨）
3. 「ルール」タブに [firestore.rules](firestore.rules) の内容を貼り付けて「公開」
4. プロジェクト設定（⚙）→「マイアプリ」からウェブアプリ（`</>`）を追加し、表示された `firebaseConfig` をコピー
5. [config.js](config.js) の内容を書き換える
6. Netlify Drop（https://app.netlify.com/drop）等にこのフォルダをドラッグ＆ドロップして公開し、発行されたURLを各端末のブラウザで開く

---

## Git / GitHub へのアップロード手順
本フォルダ（`shiaichuu soku Data`）をそのまま Git リポジトリとして管理できます。

```bash
# 1. リポジトリの初期化
git init

# 2. ファイルの追加と初回コミット
git add .
git commit -m "Initial commit: Football Data Live"

# 3. GitHub 等のリモートリポジトリへ登録してプッシュ（GitHubでリポジトリ作成後）
git branch -M main
git remote add origin <GitHubのリポジトリURL>
git push -u origin main
```

---

## ファイル構成
| ファイル | 役割 |
|---|---|
| `index.html` | アプリケーションのHTML構造 |
| `style.css` | スタイルシート（タブレット対応・大型入力UI） |
| `app.js` | メインロジック（UI制御・入力補正・大文字変換など） |
| `store.js` | データ永続化・同期層（Firebase Firestore / LocalStore） |
| `config.js` | Firebase 接続設定 |
| `config.example.js` | Firebase 接続設定のテンプレート |
| `firestore.rules` | Firestore セキュリティルール定義 |
| `.gitignore` | Git 管理から除外する設定（OS固有ファイル等） |
