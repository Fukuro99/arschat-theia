---
scope: spec
milestone: ms-6
---
# ms-6 SPEC: M5 ツール実行+承認フロー+MCP接続

## 背景・なぜこのMSが必要か

今の arschat-theia は「会話はできるが、手が出せない」状態。チャットの AI にコマンド実行・Web 検索・ファイル操作を頼んでも何もできない。現行 ArsChat では日常的に使われている機能なので、これが無い限り「現行の置き換え」として日常利用 (ドッグフーディング) に入れない。

Phase 1 設計書 (PHASE1_DESIGN.md) のゴールのうち未実装で残っているのは本 MS (設計書の M5) と ms-7 (M6: IDE 再希釈) の 2 つだけ。ツール置き場のパッケージ arschat-tools は「M5 で実装予定」と書かれた空の骨組みのまま一度も触られていない。

## 解決すべき問題

1. **AI がツールを持たない**: run_command (コマンド実行) / web_search / fetch_page / read_file / write_file / edit_file の 6 ツールが未実装
2. **危険な操作を守る仕組みがない**: コマンド実行やファイル書き込みをユーザー確認なしに走らせてはいけない。承認の判定ロジックは Theia 標準にあるが、承認ダイアログの画面は Theia 標準チャット UI (ai-chat-ui) 側にあり、本プロジェクトは ai-chat-ui を使わない方針のため画面だけ自前実装が必要
3. **現行 ArsChat の MCP サーバー設定を引き継げない**: 現行の mcp-config.json を読み込む経路がない

## 設計方針 (判断軌跡)

### 1. ツールは Theia AI の ToolProvider (= ツール提供の標準窓口) として登録する
- 理由: Theia のチャット層が自動でツールを解決し、どのプロバイダ (OpenAI/Anthropic/ローカル) でも共通に使えるため。自前のツール呼び出し配線を作らない

### 2. web_search / fetch_page は現行実装 (web-search.ts: DuckDuckGo + Turndown) をほぼそのまま移植
- 理由: API キー不要で既に動いている実装。作り直す価値がない。バックエンド側に置く

### 3. run_command は現行 code-editor-manager.ts の「実行部のみ」移植し、Glob/Grep/diff の独自実装は廃棄
- 理由: 検索系は Theia 標準 (@theia/file-search 等) や既存ライブラリが代替する。独自実装を持ち込むと二重管理になる (設計書 §8 の移植方針)

### 4. 承認はロジック流用・画面だけ自前
- Theia 1.71.2 の ToolConfirmationManager (承認モードとセッション単位の一時許可を管理する仕組み) をそのまま使い、許可/拒否ダイアログの画面だけ自前 ChatWidget 内に実装する
- run_command と書き込み系 (write_file/edit_file) は `confirmAlwaysAllow` フラグ (=「すべて許可」設定でも必ず確認を出す印) を立てる
- 理由: 承認ロジックの再発明はバグの温床。安全側に倒す判断 (危険操作は常に確認) は設計書 §7 で確定済み。ai-chat-ui の tool-confirmation.tsx を参照実装にできる

### 5. MCP は @theia/ai-mcp に乗り、変換関数だけ新規に書く
- 現行 mcp-config.json → Theia の設定 (`ai-features.mcp.mcpServers`) への変換のみ実装。現行 mcp-manager.ts は廃棄
- 理由: @theia/ai-mcp は PoC-4 で実動作確認済み。同じ機能を自前で持つ理由がない

### 6. API キーの OS キーチェーン保存 (KeyStoreService 連携) はストレッチ (= 余裕があればやる)
- 理由: 設計書 §4.2 で「Phase 1 は設定+環境変数で開始」と確定済み。受入条件には含めない

## スコープ

### やる
- 6 ツール (run_command / web_search / fetch_page / read_file / write_file / edit_file) の実装と登録
- 承認ダイアログ (許可/拒否 + 1回だけ/このセッション中/常に の範囲選択) を自前チャット画面内に実装
- ツール実行カード (実行中/承認待ち/結果) のチャット内表示
- mcp-config.json のインポート変換

### やらない (別MS or 後回し)
- IDE 再希釈・ビルトイン拡張パック → ms-7 (M6)
- ユーザーメモリ (GraphRAG) → Phase 2
- スキル由来ツールの動的登録 (ToolInvocationRegistry 経由) → 必要になったときに
- KeyStoreService 連携はストレッチ扱い、未達でも本 MS は完了にできる

## 受入条件

1. チャットで AI が run_command を要求すると承認ダイアログが表示され、許可すると実行されて結果がチャットに表示される (= 設計書 M5 の完了条件)
2. 拒否した場合はコマンドが実行されず、その旨が AI への応答として返る
3. write_file / edit_file は「すべて許可」設定にしていても毎回確認が出る
4. web_search / fetch_page がチャットから使え、検索結果・ページ本文が AI の回答に反映される
5. ツールの状態 (実行中/承認待ち/結果) がチャット内にカードとして見える
6. 現行形式の mcp-config.json を取り込むと、MCP サーバーのツールがチャットから呼べる
7. jest テストと自動検証 (ARSCHAT_M5_AUTOTEST) が PASS し、M3/M4 の回帰検証も PASS を維持する

## 実装順序のヒント

1. arschat-tools の配線を通す: read_file 等の単純ツールを ToolProvider として登録し、チャットから呼べる最小経路を先に確立 (これが通らないと以降が全部詰まる)
2. 承認フロー: ToolConfirmationManager 流用 + ChatWidget 内の承認 UI + ツールカード表示
3. run_command 移植 (承認必須を確認しながら)
4. web_search / fetch_page 移植
5. MCP インポート変換
6. 自動検証 + M3/M4 回帰

## 関連

- 設計書: PHASE1_DESIGN.md §7 (ツールと承認フロー) / §8 (移植資産マップ) / §11 (Theia 1.71.2 の確定事実)
- 関連 MS: ms-4 (M3 自前チャット UI — 承認 UI とツールカードはこの ChatWidget に載せる) / ms-7 (M6 IDE 再希釈 — 本 MS の後続)
- ビルドの知見: BUILD_NOTES.md (Theia 本体無改変原則、autotest の作法)
