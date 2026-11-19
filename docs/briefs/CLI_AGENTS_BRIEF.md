# 実装ブリーフ: Claude Code / Codex を CLI 経由で呼ぶプロバイダ

> 指揮 (Opus) 作成。実装・レビューは Codex CLI。ブランチ `feat/cli-agent-providers` (main から)。
> ユーザー決定 (2026-11-19): Claude / ChatGPT のサブスクリプションで動かしたい → 公式 CLI (`claude` / `codex`) を ArsChat から呼び出す形で良い。

## 0. ゴールと規約上の制約

ユーザー決定 (2026-11-19、権限設定の追加): 無制限モードを選択肢から除外する方針を撤回する。Codex の `danger-full-access` と Claude Code の `bypassPermissions` を明示的に選択可能とし、ヘッダーからの選択時は確認ダイアログを出す。既定値は `read-only` / `plan` を維持し、以下の認証上の制約は変更しない。

チャットヘッダーのプロバイダに 2 つ追加する (グループは「エージェント (CLI)」):

| kind | 表示名 | 呼ぶもの | 認証 |
|---|---|---|---|
| `codex-cli` | `Codex (CLI)` | ユーザーがログイン済みの公式 `codex` CLI | `codex login` (ChatGPT プラン) をそのまま使う。ArsChat はトークンに一切触れない |
| `claude-code-cli` | `Claude Code (CLI)` | ユーザーがインストール済みの公式 `claude` CLI | **Anthropic API キー必須**。後述 |

**Claude Code の認証 (規約対応)**: Anthropic の Agent SDK ドキュメントは「事前承認なしにサードパーティ製品が claude.ai ログインやその利用枠を提供すること」を禁じている。ArsChat は公開リポジトリの第三者アプリなので、Claude Code を呼ぶ時は**必ず API キーで動かす**。
- 子プロセスの環境変数から `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` を**削除**し、`ANTHROPIC_API_KEY` を設定する。
- キーの取得元: (1) ms-9 の金庫 (backend の `KeyStoreService`、service=`arschat`、account=`anthropic`)、(2) 無ければ backend プロセスの `ANTHROPIC_API_KEY` 環境変数。
- どちらも無ければ CLI を起動せず、応答として次を返して終了: 「Claude Code を呼ぶには Anthropic の API キーが必要です。チャットヘッダーの『API キー』から Anthropic のキーを保存してください (Claude のサブスクリプションのログインは、Anthropic の規約によりサードパーティのアプリからは使えません)。」
- キーは子プロセスの env にだけ渡す。ログ・例外・引数 (コマンドライン) に絶対に出さない。

Codex 側は ChatGPT ログインを CLI 自身が使うだけで、ArsChat は認証情報を読まない・保存しない・中継しない。

## 1. 実測済みの CLI 仕様 (この機械: claude 2.1.273 / codex-cli 0.162.1、どちらも `%APPDATA%\npm` の npm シム)

- **codex**: `codex exec --json --skip-git-repo-check --ephemeral -s <sandbox> [-C <dir>] [-m <model>] -` で、`-` を渡すとプロンプトを **stdin** から読む。stdout は JSONL:
  ```
  {"type":"thread.started","thread_id":"…"}
  {"type":"turn.started"}
  {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
  {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…,"reasoning_output_tokens":…}}
  ```
  `item.type` には `agent_message` の他に `reasoning`、`command_execution`、`file_change` 等がある (codex の help / ソースで確認すること)。`agent_message` を本文、`reasoning` を思考として扱い、`command_execution` / `file_change` は「Codex が実行した操作」として本文中に短い要約 (コマンド・対象ファイル名のみ) を出す。`item.started` / `item.updated` も来るなら途中経過に使ってよい。エラーは `{"type":"error"...}` / `turn.failed` 等 (要確認)。
- **claude**: `claude -p --output-format stream-json --verbose --include-partial-messages [--model <m>] [--permission-mode <mode>] [--allowedTools …]`、プロンプトは **stdin**。stream-json の各行の型 (`system`/`stream_event`(text_delta 等)/`assistant`/`user`/`result`) は `claude --help` と公式ドキュメント (code.claude.com/docs/en/headless) で確認すること。`stream_event` の text_delta を本文としてストリーム、thinking_delta があれば思考、`result` で終了 (is_error を見る)。
- Windows: どちらも npm シム (`.cmd`)。`shell: true` を避けたいので、`where` 相当で実体を解決するか `cross-spawn` 相当の処理を自前で書く (ルートの node_modules に `cross-spawn` があればそれを使ってよい、新規 npm install は禁止)。プロンプトは引数ではなく stdin で渡す (長さ・クォート問題の回避)。

## 2. 設計

### 2-1. backend の LanguageModel (arschat-providers/src/node/)
- ms-9 で追加済みの backend モジュール (`arschat-providers-backend-module.ts`) に、`LanguageModelProvider` (node_modules/@theia/ai-core/lib/node/ai-core-backend-module.js:29 の contribution provider) を bind して 2 つの LanguageModel を登録する。id は `codex-cli` / `claude-code-cli`、vendor/name は表示名に合わせる。
- `request(request, cancellationToken)` で CLI を spawn し、`LanguageModelStreamResponse` (text / thought パート) を返す。Theia の既存 backend モデル (node_modules/@theia/ai-openai/lib/node/openai-language-model.js) の戻り値の型・ストリームの作法を真似る。
- キャンセル: cancellationToken で子プロセスツリーを終了 (Windows は `taskkill /T /F /PID`)。
- 会話の渡し方 (v1): **毎ターン、ArsChat の会話履歴全体をテキストのトランスクリプトに整形して stdin に渡す** (システムプロンプト → 「ユーザー: …」「アシスタント: …」の順、最後に今回の発言)。CLI 側のセッション再開は使わない (ArsChat の編集・分岐・再生成とずれないため)。画像は v1 では未対応 (添付があれば「画像は CLI プロバイダでは送れません」と本文に注記)。
- ArsChat 側のツール (request.tools) は CLI には渡さない (CLI は自前のツールで動く)。その旨を BUILD_NOTES に書く。
- 1 リクエストのタイムアウト: 設定値 (既定 15 分)。超えたら終了してエラー表示。
- stderr はログに出してよいが、キーや env は出さない。

### 2-2. 設定 (preference、`arschat.cliAgents.*`)
| key | 既定 | 意味 |
|---|---|---|
| `arschat.cliAgents.codex.command` | `codex` | 実行ファイル |
| `arschat.cliAgents.codex.sandbox` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `arschat.cliAgents.codex.model` | `''` | 空なら CLI の既定 |
| `arschat.cliAgents.claudeCode.command` | `claude` | 実行ファイル |
| `arschat.cliAgents.claudeCode.permissionMode` | `plan` | `plan` / `acceptEdits` / `default` / `bypassPermissions`。`default` は CLI へ渡す際に `manual` に変換 |
| `arschat.cliAgents.claudeCode.model` | `''` | 空なら CLI の既定 |
| `arschat.cliAgents.workingDirectory` | `''` | 空なら開いているワークスペースのルート、それも無ければ THEIA の config dir 配下の `arschat/cli-agents` |
| `arschat.cliAgents.timeoutMinutes` | 15 | |

preference は frontend で定義されるので、backend の LanguageModel には frontend からリクエストごとに設定を渡す必要がある。最も素直な方法を node_modules で調べて選ぶ (例: LanguageModelRequest の settings、または frontend→backend の小さな RPC で設定を同期)。

- `claude --help` / `codex exec --help` で上記 CLI 引数の値を再確認済み (2026-11-19)。backend でも上記選択肢を許可リストで検証し、未知の値は安全側の既定値に戻す。
- CLI プロバイダ (`codex-cli` / `claude-code-cli`) の選択時だけ、チャットヘッダーのモデル選択の右に「権限」の select を表示し、現在の設定値を選択状態にする。変更は preference の User スコープに保存する。
- `danger-full-access` / `bypassPermissions` の選択時は Theia の `ConfirmDialog` で「このモードでは CLI がファイル削除やコマンド実行を確認なしで行えます」と確認し、承認時だけ保存、キャンセル時は元の値に戻す。他の値への変更は即時保存する。
- 無制限モード中の select は警告色にし、title に同じ説明を表示する。

### 2-3. プロバイダ一覧への追加 (arschat-providers/src/browser/)
- `ArschatProviderKind` と `PROVIDERS` に `codex-cli` / `claude-code-cli` を追加。`fixedModelId` = kind、`local` とは別に `group: 'cli'` のような区分を持たせ、チャットヘッダーの `<optgroup>` を「クラウド」「ローカル」「エージェント (CLI)」の 3 つにする。
- カスタムエンドポイントの接続先 URL 欄・モデル一覧のライブ取得は CLI プロバイダでは出さない (customEndpointProviders() に含めない)。seed にも入れない。
- `ProviderSwitchService.setActive('codex-cli')` → modelId `codex-cli`。

### 2-4. 起動前チェック
- プロバイダ選択時に CLI の存在確認 (`--version`) を backend で行い、見つからなければヘッダー下に 1 行で案内 (インストール方法: `npm i -g @openai/codex` / `npm i -g @anthropic-ai/claude-code`)。Claude Code はキー未設定の案内もここで出す。

## 3. テスト

- jest で `child_process.spawn` をモックし、実 CLI を起動しない:
  - codex の JSONL → text / thought / 操作要約への変換 (agent_message, reasoning, command_execution, file_change, エラー、途中で壊れた行)
  - claude の stream-json → text_delta のストリーム、result の is_error
  - トランスクリプト整形 (system、複数ターン、画像添付の注記)
  - Claude Code: 金庫のキー → env に ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN が子 env から消える、キー無しなら spawn しない、キーがログ・引数に出ない
  - キャンセルで子プロセス終了が呼ばれる、タイムアウト
  - sandbox / permissionMode の許可リスト外の値は既定値に落ちる
  - 権限の全選択肢と安全側の既定値、backend の許可リストと `default` → `manual` 変換
  - 権限 select の CLI 限定表示、無制限モードへの変更時の確認、キャンセルで復帰・承認で User スコープに保存、警告表示
  - JSON として解釈できない行 (空行を除く) が来たら子プロセスを止めて「CLI の出力を解釈できませんでした」で終了する (Codex / Claude 共通。破損からの復元はしない)。Claude は delta の累積と assistant の完全版を照合し、末尾欠落だけ補完、補えなければエラー
  - PROVIDERS の並びと optgroup 3 分割
- 今回撤回した無制限モード禁止に関する期待値は新仕様に更新し、他の既存テストの期待値は維持する。jest-setup の「実 keytar 禁止」は維持。

## 4. autotest `ARSCHAT_CLI_AGENTS_AUTOTEST=1`
- (1) codex: `codex-cli` を setActive → `Reply with exactly: PONG` → 返答に PONG。(2) codex 日本語: `日本の首都を漢字2文字で` → 東京。(3) claude-code: キーが無い環境では「API キーが必要」の案内が返る (CLI は起動しない) ことを確認。キーがある環境なら PONG。
- ログ `[CLI-AGENTS][autotest]`、SUMMARY 行。

## 5. 完了条件 (実装者)
1. `npm --prefix arschat-providers run build` / `npm --prefix arschat-chat run build` が tsc エラー 0。
2. 全パッケージの jest が green (`arschat-chat` / `arschat-agents` / `arschat-tools` / `arschat-branding` / `arschat-extensions`)。
3. アプリのバンドルと実機 autotest は指揮側が行う。node_modules と lib は編集禁止、npm install 禁止。git commit はしない。
4. BUILD_NOTES.md に実装メモ (構成・規約対応・既知の制約・未確認事項) を追記。

## 6. やらないこと
- CLI のログイン情報 (`~/.codex/auth.json`、Claude のログイン) の読み取り・保存・中継。
- Claude のサブスクリプションログインでの実行 (§0)。
- 無制限モードを既定にすること (明示的な選択は §0 / §2-2 のユーザー決定により許可)。
- CLI のセッション再開による会話継続 (v2 で検討)。
