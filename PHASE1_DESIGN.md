# Phase 1 設計: チャットコア移植

作成: 2026-07-04 / 前提: PoC全5項目合格(POC_PLAN.md)。Theia 1.71.2(Community Release 2026-05相当)ピン留め、本体無改変原則を継続。

## 1. ゴール / 非ゴール

**ゴール** — 現行ArsChatのチャット体験の中核が arschat-theia 上で動くこと:

- マルチプロバイダチャット(ストリーミング): **OpenAI / Anthropic / LM Studio / Unsloth Studio** の4種を設定画面から切替可能
- ペルソナ(複数人格・システムプロンプト合成・アバター)
- スキル(Markdown+frontmatter、スラッシュコマンド補完)
- AIツール実行: run_command(承認フロー付き)、web_search、fetch_page、read_file/write_file/edit
- MCPサーバー接続(現行 mcp-config.json からのインポート)
- セッション永続化と履歴パネル(件数無制限)
- 自前チャットUI(ReactWidget、メインエリア占有) — think表示・画像添付含む

**非ゴール(後続Phase)**:

- Phase 2: ユーザーメモリGraphRAG本組み込み(poc-graphragの製品化)、チャット内メモリ
- Phase 3: タスク(自律エージェント)機能、ウィジェットモードの製品化(PoC-1コードの仕上げ)、Interactive UI(AI生成UI)の再設計
- 旧ArsChatからのデータ移行ツール(セッション/設定インポータ)は Phase 1 末尾のストレッチ
- 配布(electron-builder、自動アップデート)

## 2. パッケージ構成

PoCで肥大した `arschat-core` をドメイン別のTheia拡張に再編する:

```
arschat-theia/
├── electron-app/          アプリ本体(依存宣言・theia config)
├── arschat-branding/      electron-main層: トレイ/ホットキー/ウィジェットwindow/アイコン
│                          (PoC-1成果の整理。製品化はPhase 3、Phase 1では現状維持で移動のみ)
├── arschat-providers/     LLMプロバイダ登録・切替(本設計の §4)
├── arschat-chat/          チャットUI(ReactWidget)・セッションストア・履歴パネル
├── arschat-agents/        ペルソナ→ChatAgent、システムプロンプト合成、スキル
└── arschat-tools/         run_command/web_search等のツール+承認フロー
```

分割の基準: 「後続Phaseで差し替え・拡張する単位」。過剰分割はしない(memory/tasksはPhaseが来たら新パッケージ)。

## 3. 全体アーキテクチャ方針

- **Theia AIの下層(ai-core / ai-chat / ai-mcp / 各プロバイダ)に乗り、UI(ai-chat-ui)は使わない**。
  PoC-4の知見: Theia AIのモデル層・MCP・プロバイダは実用水準、チャットUIと設定UIは発展途上。
  よって LanguageModel / ChatService / ChatAgent / ToolProvider を利用し、描画は自前ReactWidget。
- Theia AI のAPIは流動的(公式に contribution point 未固定)なので、**自前コードから直接 ai-* を触る箇所を
  arschat-providers / arschat-agents 内の薄いアダプタに集約**し、Community Release更新時の影響範囲を閉じる。
- 現行ArsChatからの移植は「ロジックのみ」。IPC配線・React UIは新規書き起こし(旧調査で問題が集中していた層のため)。

## 4. プロバイダ切替設計(新要件)

### 4.1 構成

| プロバイダ | 実現手段 | 備考 |
|---|---|---|
| Anthropic | `@theia/ai-anthropic` | PoC-4で配線済み |
| OpenAI | `@theia/ai-openai` | 公式API |
| LM Studio | `@theia/ai-openai` のカスタム(OpenAI互換)エンドポイント | 現行ArsChatの手書きSSE実装は廃棄 |
| Unsloth Studio | 同上(**OpenAI互換を公式ドキュメントで確認済み**) | `/v1/chat/completions` + `/v1/models`。localhost:8000 or 8888(要実機確認)、`Bearer sk-unsloth-...` 認証必須。Anthropic互換 `/v1/messages` も持つがOpenAI互換側を使う |

カスタムエンドポイントの設定キーは `ai-features.openAiCustom.customOpenAiModels`(**配列**)。各要素は `{ id, model, url, apiKey, enableStreaming, ... }` で、**LM StudioとUnsloth Studioを別idで同時登録可能**(v1.71.2ソースで確認済み。実機での2件同時稼働はM2で検証)。

### 4.2 切替UX

- 設定(Theia preferences)に各プロバイダの接続情報(baseUrl / apiKey / モデル名)を保持
- **アクティブプロバイダ/モデルはチャットUIのヘッダーのドロップダウンで即時切替**(現行ArsChatのUX踏襲)
- 実装: `AISettingsService.updateAgentSettings(agentId, { languageModelRequirements })` でエージェントのモデル要求を実行時更新する ProviderSwitchService を arschat-providers に置く。
  **注意(調査で判明)**: `AbstractStreamParsingChatAgent` が AISettingsService の上書き値を自動で読むかは未確認のため、ArsChatのagent実装側で `getAgentSettings(this.id)` を明示参照してセレクタを解決する(確実な方式)
- APIキー保存: AIパッケージの標準は「preference平文 > 環境変数(`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`)」の優先順位で、Theia公式自身が「安全にしたければ環境変数を使え」と警告している。
  一方 `@theia/core` には **`KeyStoreService`(keytar、OSキーチェーン連携)が存在するがAIパッケージは未使用**。Phase 1では preference+環境変数で開始し、設定UIに平文保存の注意を明示。KeyStoreService連携はM5のストレッチ(ArsChat独自の改善点になる)

### 4.3 現行コードとの対応

- claude.ts の Anthropic/LM Studio 二重実装(ツールスキーマ2重定義・SSE手書きパース)は**全廃**。
  Theia AIのプロバイダ層が代替するため、移植するのは「デフォルトモデル定数」「maxToolRounds等の設定概念」のみ

## 5. チャットUI(arschat-chat)

- `ChatWidget`(ReactWidget)がメインエリア占有(PoC-2の構造を製品コード化)
- データモデルは `@theia/ai-chat` の ChatService/ChatSession を利用、描画は自前:
  - ストリーミング表示(requestAnimationFrameバッチは現行ChatWindowの知見を流用)
  - think ブロックの折り畳み表示
  - 画像添付(Anthropic/OpenAIのマルチモーダル入力)
  - ツールコールカード(実行中/承認待ち/結果)
- **セッション永続化は Theia AI 標準の `ChatSessionStore` をそのまま使う**(設計変更: 調査の結果、自前ストア不要と判明):
  - 「最大25」は preference `ai-features.chat.persistedSessionLimit` のデフォルト値にすぎず、**`-1` で無制限**
  - `ai-features.chat.sessionStorageScope: "global"` でワークスペース非依存(configDir配下に `${sessionId}.json` + `index.json`)
  - 履歴パネルは `getSessionIndex()`(sessionId→タイトル/保存日時のマップ)で構築できる
  - `ChatSessionStore` はDIインターフェースなので、将来要件が超えたら rebind で差し替え可能(撤退経路も確保済み)
- 履歴パネル: 左サイドバーのView(現行のHistoryPanel相当)。ViewContribution で登録

## 6. ペルソナとスキル(arschat-agents)

- **ペルソナ = 動的に登録される ChatAgent**。現行 `getEffectiveSystemPrompt()`(types.ts、130行)のシステムプロンプト合成ロジックを移植し、agentのsystem promptとして供給
- ペルソナCRUD(現行Settings内のフォーム)は専用の設定Viewに分離(現行Settings.tsx 2503行の轍を踏まない)
- スキル: 現行 skill-manager.ts のローダ(Markdown+frontmatter)を移植。ただしパーサは自前実装をやめ `gray-matter` 等の既存ライブラリに置換。チャット入力のスラッシュ補完はChatWidget側で実装
- ChatAgentの動的登録可否・API詳細は調査結果待ち(不可なら「単一のArsChat agentがアクティブペルソナのプロンプトを差し替える」方式にフォールバック — UX上の差異なし)

## 7. ツールと承認フロー(arschat-tools)

- ai-core の ToolProvider(tool function)として登録: `run_command` / `web_search` / `fetch_page` / `read_file` / `write_file` / `edit_file`
  - web_search / fetch_page: 現行 web-search.ts(DuckDuckGo + Turndown)をほぼそのまま移植(バックエンド)
  - run_command: 現行 code-editor-manager.ts の実行部を移植。**Glob/Grep/diffの独自実装は廃棄**し、ripgrep/既存ライブラリまたはTheia標準(@theia/file-search等)に置換
- **承認フロー**: Theia 1.71.2 に承認機構が**存在することを確認済み**:
  - `ToolConfirmationMode`(ALWAYS_ALLOW / CONFIRM / DISABLED)+ preference `ai-features.chat.toolConfirmation`(ツールID or `*` → モード)
  - `ToolConfirmationManager` がセッション単位の一時許可と永続設定を管理
  - `ToolRequest.confirmAlwaysAllow` フラグで「`*`がALWAYS_ALLOWでも強制確認」にできる → **run_command / write系はこれを立てる**
  - **注意**: 承認ダイアログのUI実装は ai-chat-ui 側にあり、我々はai-chat-uiを使わないため、**承認UI(Allow/Deny+Once/Session/Foreverスコープ)は自前ChatWidget内に実装**する。ロジック(ToolConfirmationManager)は流用
- ツール登録は `bindToolProvider(MyToolProvider, bind)`(ai-core)。MCPの例に倣い `ToolInvocationRegistry.registerTool()` での動的登録も可(スキル由来ツール等に有用)
- MCP: `@theia/ai-mcp`(PoC-4で実動作確認済み)。現行 mcp-config.json → `ai-features.mcp.mcpServers` preference への変換関数を用意

## 8. 移植資産マップ(現行 → Phase 1)

| 現行(src/main) | 行き先 | 移植方法 |
|---|---|---|
| claude.ts (1757行) | ほぼ廃棄 | プロバイダ層はTheia AIが代替。設定概念のみ移植 |
| skill-manager.ts | arschat-agents | ロジック移植+パーサをライブラリ化 |
| web-search.ts | arschat-tools | ほぼそのまま |
| code-editor-manager.ts | arschat-tools(実行部のみ) | Glob/Grep/diff独自実装は廃棄 |
| mcp-manager.ts | 廃棄 | @theia/ai-mcp が代替。設定変換のみ新規 |
| store.ts | 分解 | 設定→Theia preferences、セッション→SessionStore |
| index.ts (2074行) | 廃棄 | IPC配線という概念自体が消滅(Theia RPC/DIが代替) |
| shared/types.ts | arschat-* 各所 | ドメイン型+getEffectiveSystemPromptを分割移植 |
| ChatWindow.tsx / MessageBubble.tsx | arschat-chat | UXを参照実装として新規書き起こし |
| user-memory-manager.ts (Neo4j) | Phase 2 | poc-graphragの設計で置換 |
| task-manager.ts / extension-*.ts / hook-manager.ts | Phase 3以降 / 廃棄検討 | 独自拡張機構はVSC拡張+Theia拡張が代替 |

## 9. 実装順序(マイルストーン)

| MS | 内容 | 完了条件 |
|---|---|---|
| M1 | パッケージ再編(§2)+PoC検証コードの整理(autotest群をfeature flag化) | 再編後もPoC全項目の起動確認が通る ✅ **完了 2026-07-04**(arschat-core解体→branding/providers/chat/agents/tools。完了条件1-5全PASS、詳細はBUILD_NOTES.md「Phase 1 M1 実装メモ」) |
| M2 | プロバイダ4種切替(§4) | 各プロバイダとの実チャット往復(Unsloth Studioは仕様確認でき次第) ✅ **実装完了 2026-07-04・ライブ検証は 0/4(環境制約でSKIP)**。4プロバイダのモデルがLanguageModelRegistryに登録・ヘッダーのドロップダウンで即時切替可能・切替がagentのモデル解決に反映されることを実機ログで確認。**§10リスク精査結論: フロントエンドのLanguageModelRegistryが`AISettingsService.updateAgentSettings`の`languageModelRequirements`を自動参照し、agent自身のセレクタより優先する(node_modules実測)。ProviderSwitchServiceはこの経路とagentインスタンスフィールド直書きの両方を駆動**。ライブ往復(PONG)は APIキー/ローカルサーバ不在のため4/4 SKIP、検証手順はBUILD_NOTES.md「Phase 1 M2 実装メモ」に記載。詳細同メモ参照 |
| M3 | 自前チャットWidget+SessionStore+履歴パネル(§5) | ストリーミング・履歴復元・セッション切替が動く ✅ **実装完了 2026-07-04**。チャットWidget本実装(rAFバッチ・streaming、marked+highlight.js+DOMPurifyでMarkdown/コードハイライト、`<think>`折り畳み、画像添付=**ImageContextVariable経由で実装完了(断念せず)**、abort中断ボタン、M2ヘッダードロップダウン維持)、セッション永続化(electron-app に `persistedSessionLimit:-1`/`sessionStorageScope:"global"`。標準ChatSessionStoreが自動保存・自動タイトル)、左サイドバー履歴パネル(ViewContribution、`getPersistedSessions()`で一覧・クリック復元・新規・削除)を実装。**検証**: jest 10/10 PASS(Markdown+実highlight.js、DOMPurifyサニタイズ、`<think>`パース、Widget描画)、電メインPoC-1回帰 全PASS、PoC-2メニューフィルタ発火を全runで確認。ライブElectronシェル描画/フロントエンドonStart(ARSCHAT_M3_AUTOTEST)は**この検証サンドボックスでシェルが描画されない環境制約でSKIP**(M2再runでも同一症状=6KBローディングオーバーレイのまま、M3固有ではない)。スクリーンショットは実レンダリングパイプライン(実CSS+実renderMarkdown出力)からpuppeteerで生成: `poc-artifacts/m3-chat-ui.png`(思考プロセス折り畳み・TSコードハイライト・Markdown・履歴パネル)/`m3-history-panel.png`。詳細はBUILD_NOTES.md「Phase 1 M3 実装メモ」 |
| M4 | ペルソナ+スキル(§6) | ペルソナ切替でシステムプロンプトが変わる、/スキルが補完・展開される ✅ **完了 2026-07-04**。ペルソナ=**単一のArsChat agentがアクティブペルソナの合成プロンプトを`getSystemMessageDescription()`で送信時に反映する方式**(§6の選択肢(a)、根拠はBUILD_NOTES.md M4メモ)。PersonaService(CRUD+`${configDir}/arschat/personas.json`永続化+旧`getEffectiveSystemPrompt`の合成ロジック移植)、SkillService(`${configDir}/arschat/skills/*.md`をgray-matterでロード・サンプル2つ`/summarize`/`/translate`をシード・スラッシュ展開)、チャットヘッダーにペルソナドロップダウン、左サイドバーにペルソナ管理View(作成/編集/削除/切替)、入力欄の`/`スラッシュ補完ポップアップ、スキル手動リロードコマンドを実装。**検証(ARSCHAT_M4_AUTOTEST=1、実機ログ)**: (a)ペルソナ2つ作成→切替→送信でモックが受け取るsystemプロンプトが切り替わる=PASS、(b)スキル一覧ロード=PASS、(c)/スキル展開送信で本文が展開されモデルに届く=PASS、(d)personas.json/skills/*.md永続化+リロード=PASS(ディスク上のファイルも確認)。jest: agents 11/11・chat 11/11。M3回帰(ARSCHAT_M3_AUTOTEST=1)=PASS維持。スクショ`poc-artifacts/m4-persona-switch.png`(ペルソナ管理パネル+ヘッダードロップダウン)/`m4-skill-complete.png`(スラッシュ補完ポップアップ表示、実Electronシェルで撮影)。詳細はBUILD_NOTES.md「Phase 1 M4 実装メモ」 |
| M5 | ツール+承認+MCPインポート(§7) | run_commandが承認ダイアログ経由で実行される。**e-2 完了 2026-07-05**: `read_file`/`write_file`/`edit_file` の3ツールを `@theia/ai-core` の `ToolProvider`(`bindToolProvider`)として arschat-tools に実装・登録し、アクティブな ArsChat ChatAgent の `additionalToolRequests` に接続(起動時に `ToolInvocationRegistry.getFunctions(...ids)` で解決 → `agent.setToolRequests()`)。ファイル I/O は Theia の `FileService`+`WorkspaceService`(node fs 直叩き回避)。edit の文字列置換ロジックは pure な `common/edit-file.ts`(unit テスト済)。**承認は e-3 範囲**: Theia 1.71.2 の既定 `ToolConfirmationMode` は通常ツール(`confirmAlwaysAllow` 無し)に対し **ALWAYS_ALLOW** = 無確認実行なので、3ツールは意図的に `confirmAlwaysAllow` を付けず、preference 変更も不要で e-2 の暫定として write/edit が無確認で動く(e-3 で承認 UI + write系の confirm 化)。jest: tools 12/12・agents 11/11・chat 11/11(回帰なし)。`yarn build:electron` webpack `compiled successfully`(生成 frontend に arschat-tools モジュール登録を確認)。**ライブ検証(実際に AI に read_file を頼む)は API キー不在の検証サンドボックス制約で未実施**(M2〜M4 と同じ)。詳細は BUILD_NOTES.md「Phase 1 M5 実装メモ (e-2)」。<br>**e-3 完了 2026-07-05**: 承認ダイアログ + ツール実行カードを自前 ArschatChatWidget に実装し、write系を無確認から卒業。`write_file`/`edit_file` の ToolRequest に `confirmAlwaysAllow`(文字列=警告文)を付与 → Theia の `ToolConfirmationManager.getConfirmationMode()` が **CONFIRM** に落ちる(read_file は付けず ALWAYS_ALLOW 維持)。CONFIRM 分岐では `FrontendChatToolRequestService` が `content.requestUserConfirmation()`+`response.fireInteractionNeeded()` を発火し `content.confirmed` を await して**実行を止める**ので、widget が response content 中の `ToolCallChatResponseContent` を検出してカード描画(承認待ち→実行中→結果、長い出力は折り畳み)、[許可/セッション中/常に許可]+[拒否]で `content.confirm()`/`deny()` を呼ぶ。スコープは `ToolConfirmationManager.setSessionConfirmationMode`/`setConfirmationMode` を流用(状態は自前で再発明せず)。拒否時は Theia が denial を tool result として LLM に返す(handler 本体は走らない)。ついでに read_file を 5万字で truncate。jest: tools 14/14(+2)・chat 14/14(+3)・agents 11/11(回帰なし)、`ToolCallChatResponseContentImpl` 実体で confirm→実行/deny→停止 の両分岐を検証。`yarn build:electron` `compiled successfully`。詳細は BUILD_NOTES.md「Phase 1 M5 実装メモ (e-3)」<br>**e-4 完了 2026-07-05**: `run_command` を承認必須で実装(**arschat-tools 初の backend モジュール**)。コマンド実行は Node が要るので処理は backend(`src/node/command-runner-service-impl.ts`)に置き、frontend の `RunCommandToolProvider` から **JSON-RPC proxy** で呼ぶ(Theia の `RpcConnectionHandler`/`RemoteConnectionProvider` パターン、`@theia/file-search` を先例に。service path=`/services/arschat-run-command`)。package.json `theiaExtensions` に `"backend": "lib/node/arschat-tools-backend-module"` を追加(`arschat-branding` の `electronMain` 宣言が先例)→ 生成 `server.js` に backend module 登録を確認。cwd はワークスペースルート解決を frontend(`WorkspaceService`)が担い backend には絶対パスを渡す。`confirmAlwaysAllow`(文字列警告)付与で e-3 の承認カードにそのまま乗る(受入①②③は e-3 汎用フローで達成)。**移植元(ArsChat code-editor-manager.ts)の2つの穴を修正**: (1)出力上限なし→stdout+stderr 合計 5万字上限(read_file と整合)で `...(truncated)`、(2)timeout 時 `proc.kill()` のみでプロセスツリー残留→**Windows は `taskkill /pid <pid> /T /F`、POSIX は `detached` spawn + `process.kill(-pid,'SIGKILL')` でツリーごと kill**。pure 部(シェル引数組立=`buildShellInvocation`、truncation=`truncateOutput`)は `common/run-command.ts` に分離。jest: tools 33/33(+19: run-command pure 9・command-tool-request 8・**backend 実 spawn smoke 3**〔echo 出力・非0 exit・timeout で実 kill 検証〕)・chat 14/14・agents 11/11(回帰なし)。`yarn build:electron` `compiled successfully`(生成 backend に `arschat-tools/lib/node/*` 2 module を確認)。詳細は BUILD_NOTES.md「Phase 1 M5 実装メモ (e-4)」<br>**e-5 完了 2026-07-05**: `web_search` / `fetch_page` を現行 ArsChat `web-search.ts` から backend 移植(e-4 の backend+RPC 足場に**新サービス `WebFetchService` を1本足すだけ**、service path=`/services/arschat-web-fetch`)。DuckDuckGo HTML スクレイプ + Turndown(HTML→Markdown)は Node が要るので backend(`src/node/web-fetch-service-impl.ts`)で実行、frontend の `WebSearchToolProvider`/`FetchPageToolProvider` から JSON-RPC proxy で呼ぶ。追加依存 `turndown ^7.2.4`+`@types/turndown`、`fetch` は Node 18+ ビルトイン。**read-only 扱いで `confirmAlwaysAllow` を付けない**=既定 ALWAYS_ALLOW で無確認実行(read_file と同扱い、run_command との差はここだけ)。**移植で変えた点**: (1)HTTP 失敗/タイムアウトは throw ではなく frontend factory が `toolError('ERROR: …')` 文字列で LLM に返す、(2)`fetch_page` は原典の既定 15,000 char を尊重しつつ caller 指定 maxLength を 50,000 ハード上限にクランプ(read_file/run_command と整合)、(3)タイムアウトは原典どおり web_search 15s/fetch_page 20s 維持。DDG パース(`result__snippet`/`result__a` 正規表現・`uddg` 実 URL 復元・duckduckgo.com 除外)・Markdown 変換・打ち切りは pure 関数 `common/web-fetch.ts` に分離し**固定 HTML フィクスチャで jest 検証**(実ネットワーク非依存)。jest: tools 55/55(+22: web-fetch pure 12・web-fetch-tool-request 10〔read-only=confirmAlwaysAllow 無しを明示検証〕)・chat 14/14・agents 11/11(回帰なし)。**実ネットワーク smoke 2本は既定 `describe.skip`**(`ARSCHAT_WEB_SMOKE=1` の時だけ実行、CI/オフラインでも壊れない)、手動 `ARSCHAT_WEB_SMOKE=1` で 57/57 PASS を確認(実 DDG 検索が title+URL 返す/example.com を実取得し非空 Markdown)。`yarn build:electron` `compiled successfully`(生成 backend に `arschat-tools/lib/node/*` 3 module を確認)。受入①②(検索結果/ページ本文が回答に反映される配線)は「6ツールが agent の additionalToolRequests に載る」構造で達成、実キーでの LLM 往復は e-10 に集約。詳細は BUILD_NOTES.md「Phase 1 M5 実装メモ (e-5)」<br>**e-6 完了 2026-07-05**: 現行 ArsChat の `mcp-config.json`(`%APPDATA%\ArsChat\arschat-data\mcp-config.json`)を Theia 純正 `@theia/ai-mcp` の preference `ai-features.mcp.mcpServers` に**変換して取り込むコマンド**を実装。**MCP は自前実装せず PoC-4 で実証済みの `@theia/ai-mcp` に乗せる**方針。変換は pure `common/mcp-config-import.ts`(`convertLegacyMCPConfig`/`mergeIntoExisting`、Theia 非依存で jest 済)。コマンド `arschat-tools:mcp:import-legacy`「ArsChat: 旧 ArsChat から MCP 設定をインポート」(`CommandContribution`、コマンドパレット)が既定パス(`EnvVariablesServer` で APPDATA 解決、無ければ `FileDialogService` で選択)を `FileService.read`(読み取りのみ)→変換→`mergeIntoExisting` で既存 preference と**非破壊マージ(既存が勝ち)**→`PreferenceService.set(MCP_SERVERS_PREF, ..., User)`→結果を `MessageService` で通知。**変換先スキーマを @theia/ai-mcp 実ソースで裏取り**: (a) http/streamable-http は**両方サポート**だが `type` 判別子は無く**構造判定**(`command`→local/`serverUrl`→remote)、remote は StreamableHTTP→SSE フォールバックを Theia が持つので両者を 1 個の `serverUrl` remote に統合(情報欠落なし)、(b) `enabled:false`→**`autostart:false`**(取り込むが自動起動しない)、(c) `env`/`headers` は透過(空マップは省略)、`description` はスキーマ非対応で**破棄**(黙って落とさず注記)。変換不能(name 空/command も url も無い/不正ルート)は throw せず**理由付き warning を通知**(受入②)。追加依存 `@theia/ai-mcp 1.71.2`(preference key/型 import 用、root に hoist 済)。インポートは明示操作なので承認フロー(e-3)無関係。jest: tools **70/70**(+15、必須フィクスチャ stdio/http/streamable-http/enabled:false/欠落を全網羅+実データ相当4サーバー一括+merge)・chat 14/14・agents 11/11(回帰なし)。**実 mcp-config.json での dry-run(受入⑤)**: 実在4サーバーを読み取りのみで変換→`importedCount=4`/warnings=0(filesystem/Atlassian/discord=stdio→local、resonitelink=streamable-http→remote、description 破棄注記3件)、preference 書き込みはせず。`yarn build:electron` `compiled successfully`(生成 frontend bundle にコマンド id/ラベルを確認)。受入①(変換結果が preference に書かれ ai-mcp 起動可能に)は実データ変換+純正 preference key への set で構造的に達成、UI からの実インポートは GUI サンドボックス制約で未実施。詳細は BUILD_NOTES.md「Phase 1 M5 実装メモ (e-6)」<br>**e-7 完了 2026-07-05**: `ARSCHAT_M5_AUTOTEST=1` の**完全オフライン**自動検証を整備(M2〜M4 のログベース autotest 作法を踏襲、`arschat-tools/src/browser/arschat-m5-autotest-contribution.ts`)。モックが**プロバイダアダプタを演じて** `request.tools` のラップ済み handler を自分で呼ぶ設計(agent は tool_call content を追加するだけで handler は呼ばないと `chat-agents.js` 実測で確認)により、承認ゲート込みの実往復を検証。confirm 必須ツールは autotest が response の `onInteractionNeeded` で `ToolCallChatResponseContent` を捕まえて `confirm()`/`deny()` をプログラム発火(e-3 widget test の実体駆動方式を実 agent 往復に載せた)。**5シナリオ全 PASS(実機ログ、SUMMARY: 5 PASS / 0 FAIL)**: (1)6ツールが registry + agent.additionalToolRequests に登録=PASS、(2)read_file で一時ファイル内容が tool result で返る・承認不要で走る=PASS、(3a)write_file 承認待ち→confirm→実ファイル書込=PASS/(3b)deny→未書込+denial result=PASS、(4)run_command 承認→backend RPC 経由で echo 実行・exit0+stdout=PASS(**完了条件「run_command が承認ダイアログ経由で実行される」をシナリオ3+4 でログ実証**)、(5)MCP 変換 dry-run で importedCount=3/warnings=0・preference 書込なし=PASS。web_search/fetch_page は実ネット要のためシナリオ1(登録)のみ、実行系は e-5 jest smoke(`ARSCHAT_WEB_SMOKE=1`)担当。**M3 回帰(ARSCHAT_M3_AUTOTEST=1)**=streaming/persistence/restore 全 PASS(この run はシェル描画成功、M3 メモの SKIP から実機 PASS に到達)、**M4 回帰(ARSCHAT_M4_AUTOTEST=1)**=ペルソナ切替/スキル/展開/永続化+スラッシュ補完 全 PASS 維持。jest 回帰なし(tools 70/70・chat 14/14・agents 11/11)、`yarn build:electron` `compiled successfully`。実キーでの実プロバイダ往復は e-10 に集約。詳細は BUILD_NOTES.md「Phase 1 M5 実装メモ (e-7)」<br>**e-10 完了 2026-07-05**: **実 LLM ライブ検証**(`ARSCHAT_M5_LIVE=1`、`arschat-tools/src/browser/arschat-m5-live-contribution.ts`)。e-7 のオフライン基盤をライブ化し、**LAN の LM Studio(OpenAI 互換、`http://192.168.1.149:1234/v1`・`qwen/qwen3.6-35b-a3b`、いずれも `ARSCHAT_M5_LIVE_URL`/`ARSCHAT_M5_LIVE_MODEL` で上書き可)** に対しモック無しで実チャット往復。起動時に共有 `lmstudio` エンドポイントの url/model を User スコープで書き換え(`@theia/ai-openai` が `lmstudio` LanguageModel を再登録)、`AISettingsService`+agent instance で ArsChat agent を切替(※`ProviderSwitchService.setActive` は `arschat.provider.*` を Workspace スコープに書こうとしてフォルダ未オープンの headless で失敗するため回避)。承認は e-7 と同じく `onInteractionNeeded`→`content.confirm()`/`deny()` をプログラム発火。分離は **`THEIA_CONFIG_DIR` を一時ディレクトリに向けて**達成(preference 書込・scratch ファイルは全部そこ)、加えて変更した 2 preference(customOpenAiModels/toolConfirmation)を実行後に復元、旧アプリ DATA(`%APPDATA%\ArsChat\arschat-data`)は無改変を確認。**結果(実機ログ、SUMMARY: 4 PASS / 0 FAIL + L4 計測)**: L1 read=**PASS**(実 LLM が read_file を呼び合言葉を回答、1発)、L2 write 承認→実行=**PASS**(承認前は未書込・confirm 後に実ファイル書込)、L3 write 拒否=**PASS**(2発目で成功。1発目は LLM が「サーバー側からローカルパスに触れない」と判断しツール未呼出)、L5 run_command=**PASS**(2発目。1発目は非決定的タイミングで確認前に応答確定)、**L4「常に許可」実測=RE-CONFIRMED(write系では効かない)**。**L4 の意味**: widget の `onToolAllow('forever')` は `setConfirmationMode('write_file', ALWAYS_ALLOW)` を **ToolRequest 引数なし**で呼ぶ→Theia の `ToolConfirmationManager` は「ALWAYS_ALLOW が既定」とみなし `toolConfirmation['write_file']` キーを**削除**(格納しない)→次の `getConfirmationMode`(実行経路では ToolRequest 付きで呼ばれる)が `confirmAlwaysAllow` を見て **CONFIRM に戻す**ため、**write_file/edit_file では「常に許可」ボタンが実質無効で毎回再確認される**(セキュリティ上は安全側に倒れるが UX は仕様バグ。M6 以降で widget が `setConfirmationMode(id, mode, toolRequest)` に ToolRequest を渡すか、`confirmAlwaysAllow` 系専用の格納経路を用意すべき)。**普段の設定は汚していない**(THEIA_CONFIG_DIR 隔離 + preference 復元)。jest 回帰なし(tools 70/70)、`yarn build:electron` `compiled successfully`。詳細は BUILD_NOTES.md「Phase 1 M5 実装メモ (e-10)」 |
| M6 | IDE再希釈(plugin-ext導入で復活したdebug/scm等のFilter拡大)+ビルトイン拡張パック同梱 | PoC-2水準の見た目に戻る+主要言語のハイライトが動く |

各MSは「動くものを維持したまま積む」。M2完了時点から実際に日常利用しながらドッグフーディング可能。

## 10. リスクと対応

| リスク | 対応 |
|---|---|
| Theia AI APIの流動性 | Community Releaseピン留め+ai-*直接依存をアダプタに集約(§3) |
| AISettingsService とagentのモデルセレクタの自動連携が未確認 | agent実装側で明示的に getAgentSettings を参照(§4.2)。M2冒頭で連携部を精査 |
| LM Studio + Unsloth Studio の2エンドポイント同時稼働が実機未検証 | コード構造上は可(配列diff)。M2で実機テスト |
| 承認UIの自前実装コスト | ロジックはToolConfirmationManager流用、UIのみ実装(§7)。ai-chat-uiのtool-confirmation.tsxを参照実装にできる |
| APIキー平文保存 | 設定UIで明示+M5ストレッチでKeyStoreService連携(§4.2) |

## 11. 調査で確定した事実(2026-07-04、根拠はTheia 1.71.2ソース/公式doc)

- ✅ カスタムOpenAI互換: `ai-features.openAiCustom.customOpenAiModels`(配列、複数同時登録可)
- ✅ Unsloth Studio: OpenAI互換API(`/v1/chat/completions`)+Bearer認証。ポートは8000/8888(実機確認要)
- ✅ ツール承認: 1.71.2に機構あり(ToolConfirmationMode/Manager+preference)。UIのみ自前実装が必要。1.72でWorkspace Trust連携が強化される(Community Release更新時に取り込み)
- ✅ セッション: `persistedSessionLimit=-1`で無制限、`sessionStorageScope=global`でワークスペース非依存、`ChatSessionStore`はrebind可
- ✅ ChatAgent: `registerChatAgent`/`unregisterChatAgent`の動的登録APIが正式に存在(ペルソナ=動的agent方式でOK)
- ✅ APIキー: preference > 環境変数の優先順。KeyStoreService(OSキーチェーン)はcoreに実在するがAIパッケージ未使用
