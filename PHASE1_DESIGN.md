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
| M1 | パッケージ再編(§2)+PoC検証コードの整理(autotest群をfeature flag化) | 再編後もPoC全項目の起動確認が通る |
| M2 | プロバイダ4種切替(§4) | 各プロバイダとの実チャット往復(Unsloth Studioは仕様確認でき次第) |
| M3 | 自前チャットWidget+SessionStore+履歴パネル(§5) | ストリーミング・履歴復元・セッション切替が動く |
| M4 | ペルソナ+スキル(§6) | ペルソナ切替でシステムプロンプトが変わる、/スキルが補完・展開される |
| M5 | ツール+承認+MCPインポート(§7) | run_commandが承認ダイアログ経由で実行される |
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
