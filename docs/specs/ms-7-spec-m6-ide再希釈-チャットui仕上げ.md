---
scope: spec
milestone: ms-7
---
# ms-7 SPEC: M6 IDE再希釈 + チャットUI仕上げ

## 背景
M5 で @theia/plugin-ext / plugin-ext-vscode / vsx-registry を導入した際、推移的依存で約20パッケージ (scm / debug / task / test / console / notebook / search-in-workspace 等) が入り、PoC-2 の ArschatMenuFilterContribution (arschat-branding/src/browser/arschat-ide-dilution.ts) が守っていた「チャットアプリらしい見た目」が崩れた (Run メニュー・ActivityBar の SCM/デバッグ/テスト/検索アイコンが復活)。BUILD_NOTES.md:195 参照。

## 問題
1. IDE 要素の露出: メニューバー・ActivityBar・コマンドパレットに IDE 由来の項目が多数露出し「チャットアプリ」に見えない。
2. シンタックスハイライトは M3 で実装済み (marked + highlight.js 192言語 + DOMPurify、arschat-chat/src/browser/arschat-markdown.ts) だが、実 Electron シェルでの実機確認が未実施 (jest + puppeteer のオフスクリーン確認のみ)。
3. 旧 ArsChat にあった見た目要素が未移植: KaTeX 数式 (marked-katex-extension)、メッセージホバー時アクションボタン群、トークン数/速度統計バー (ArsChat/src/renderer/components/MessageBubble.tsx)。

## 設計方針
- 再希釈: FilterContribution / ContributionFilterRegistry の対象クラス拡大を主軸に、electron-app/package.json の theia.frontend.config.preferences による宣言的非表示 (ステータスバー非表示と同じアプローチ) を併用。パッケージ削除はしない (plugin-ext の推移的依存のため不可能)。
- ハイライト: 現行 marked + highlight.js 方式を維持。@theia/ai-chat-ui の Monaco 埋め込み方式は不採用 (コードブロック毎に Monaco インスタンスは重い、arschat-markdown.ts:6-19 の既存判断を踏襲)。192言語フルバンドルは維持し、サイズ計測のみ行う (ユーザー判断 2026-07-08)。
- 旧UI移植: MessageBubble.tsx のバブル形状・アバターは移植済みのため、残り3要素 (KaTeX / アクションボタン / 統計バー) を移植。アクションボタンは現アーキで意味のあるもの (コピー/再生成/削除等) に絞る。

## スコープ
- In: IDE再希釈 (e-21)、hljs サイズ計測 (e-22)、KaTeX (e-23)、アクションボタン (e-24)、統計バー (e-25)、実機確認+自動検証+回帰 (e-26)
- Out: hljs 言語サブセット化、API キーのキーチェーン保存 (e-8 スキップ済)、Monaco ベースのハイライト

## 受入条件
1. 起動時のメニューバー・ActivityBar・ステータスバーが PoC-2 水準 (チャットアプリの顔) に戻っている
2. 実 Electron シェルでコードブロックのハイライトが主要言語で色分け表示される
3. $...$ / $$...$$ の数式が KaTeX でレンダリングされる
4. assistant メッセージにホバーアクションと統計バーが表示される
5. ARSCHAT_M6_AUTOTEST が通り、M3〜M5 の既存検証も回帰しない

## 実装順序
e-21 (再希釈) + e-22 (計測) → e-23〜e-25 (チャットUI) → e-26 (検証)
実装は Opus サブエージェント、レビューは Fable (本セッション)。作業は .worktrees/ms-7-m6 (branch: ms-7-m6)。
