# 実装ブリーフ: Claude Code (CLI) を API キーではなく CLI 自身のログイン (サブスクリプション) で動かす

> 指揮 (Opus) 作成。実装・レビューは Codex CLI。作業ブランチ: `feat/cli-agent-providers` (3ff8ff4 の上)。
> ユーザー判断 (2026-11-19): 「Claude Code はキーで動かさない。サブスクリプションで。先にログインしておけばいい」。
> 前提の実測: `claude --version` = 2.1.273。`claude auth status` は stdout に JSON を出す。未ログイン時は
> `{"loggedIn": false, "authMethod": "none", ...}` で exit code 1 (ログイン済み時は exit 0 の想定。exit code ではなく JSON の `loggedIn` で判定すること)。

## 0. ゴール

- ユーザーが事前にターミナルで `claude` → `/login` (または `claude auth login`) しておけば、ArsChat の「Claude Code (CLI)」はその CLI が保存しているログイン (= Claude のサブスクリプション) で動く。
- ArsChat 自身は認証情報を一切読まない・持たない・渡さない。CLI が自分の設定ディレクトリ (`~/.claude`、または `CLAUDE_CONFIG_DIR`) から読むだけ。
- API キー方式は廃止する (選択肢として残さない)。チャットヘッダーの「API キー」ダイアログの Anthropic 行は Anthropic (API) プロバイダ用なのでそのまま残す。

## 1. 変更点

### 1-1. `arschat-providers/src/node/cli-agent-service.ts`
- `cliArguments('claude-code-cli', …)` から `--bare` を外す (それ以外の引数は現状維持)。`--bare` に関するコメントも削除。
- `apiKey()` と `KeyStoreService` の inject を削除。Claude のリクエストで `ANTHROPIC_API_KEY` を env に入れる処理を削除。
- 新メソッド `protected claudeLoggedIn(command: string): Promise<boolean | undefined>`:
  - `spawnCli(command, ['auth', 'status'], cliEnvironment('claude-code-cli', process.env))` を起動し、stdout を最大 64KB まで読む。stderr は読み捨て (ログに出さない)。
  - タイムアウト 10 秒。プロセス終了後に stdout 全体を `JSON.parse` し、`loggedIn === true` なら true、`loggedIn === false` なら false。起動失敗・タイムアウト・JSON でない・`loggedIn` が boolean でない時は `undefined` (= CLI が使えない扱い)。
  - 失敗時・タイムアウト時は既存の `killCliTree` / `destroyCliPipes` の流儀で後始末。exit code は判定に使わない (未ログインで 1 を返すため)。
  - stdout にはメールアドレスや組織名が含まれ得るので、内容をログ・例外メッセージ・戻り値に一切出さない。
- `check('claude-code-cli', …)`: `--version` の代わりに `claudeLoggedIn` を使う。
  - true → `{ available: true, loggedIn: true }`
  - false → `{ available: false, loggedIn: false, message: CLAUDE_LOGIN_REQUIRED }`
  - undefined → 既存の「CLI が見つからないか起動できません。インストール: npm i -g @anthropic-ai/claude-code」
  - Codex の check は現状のまま (`--version`)。
- `request('claude-code-cli', …)`: 本体 (`-p`) を起動する前に `claudeLoggedIn` を呼ぶ。false なら `-p` を起動せず `{ text: CLAUDE_LOGIN_REQUIRED }` を返す。undefined なら既存の起動失敗と同じく `throw new Error('CLI を起動できませんでした。実行ファイルと作業ディレクトリを確認してください。')`。キャンセル済みなら何も起動せず `{ text: '' }`。
- Redactor は残してよい (秘密リストが空になるだけ)。不要になった import は消す。

### 1-2. `arschat-providers/src/node/cli-agent-env.ts`
- 第 3 引数 `apiKey` を削除。
- Claude の時だけ `CLAUDE_CONFIG_DIR` を通す (ユーザーが設定ディレクトリを移している場合に、CLI が保存済みログインを見つけられるように)。Codex の時は `CODEX_HOME` を通す (現状維持)。
- それ以外の認証系は今まで通り全部落とす。特に `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / Bedrock・Vertex・Mantle 切替は渡さない (= 環境変数に API キーがあっても API 従量課金に黙って切り替わらず、必ず保存済みログインを使う)。

### 1-3. `arschat-providers/src/common/cli-agents.ts`
- `CLAUDE_KEY_REQUIRED` を削除し、`CLAUDE_LOGIN_REQUIRED` を追加:
  `'Claude Code にログインしていません。ターミナルで `claude` を起動し、/login で Claude のサブスクリプションのアカウントにログインしてから、もう一度送ってください。'`
- `CliAgentCheck` の `keyAvailable?: boolean` を `loggedIn?: boolean` に置き換え。

### 1-4. `arschat-providers/src/browser/cli-agent-autotest-contribution.ts`
- 3 つ目のシナリオ名を `claude-pong-or-login-required` に。`check.loggedIn === false` の時の期待文字列を `'ログインしていません'` に。

### 1-5. `arschat-providers/src/browser/cli-agent-preferences.ts`
- `claudeCode.command` に `markdownDescription` を付ける: 「Claude Code CLI の実行ファイル。事前にターミナルで `claude` を起動してログインしておくと、そのログイン (Claude のサブスクリプション) で動きます。ArsChat は認証情報を読みません。」

### 1-6. その他
- `keyAvailable` / `CLAUDE_KEY_REQUIRED` / `--bare` / Claude 用 API キーを参照している箇所 (widget・テスト・autotest) をすべて追従させる。`grep -rn "keyAvailable\|CLAUDE_KEY_REQUIRED\|--bare" arschat-*/src` が 0 件になること。

## 2. テスト (jest、`arschat-chat/src/browser/arschat-cli-agents.test.ts` を更新)

挙動を意図的に変えるので、Claude の API キー前提のテストは書き換えてよい。Codex のテストの期待値は変えない。
- `cliArguments('claude-code-cli', …)` に `--bare` が無い。
- env: Claude では `CLAUDE_CONFIG_DIR` が通り、`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` は process.env にあっても渡らない。Codex では `CLAUDE_CONFIG_DIR` は渡らない (許可リスト固定テストを更新)。
- request: 1 回目の spawn が `['auth','status']`、`{"loggedIn":true}` を返すと 2 回目に `-p` が起動される。`{"loggedIn":false}` (exit 1) なら `-p` を起動せず `CLAUDE_LOGIN_REQUIRED` を返す。
- check: loggedIn true / false / 非 JSON / タイムアウト (fake timers) / spawn の error の各ケース。非 JSON・タイムアウト・error は「インストール」メッセージ。
- auth status の stdout に含まれるメールアドレスがログ・戻り値に出ない (console.log / console.error を spy)。
- KeyStoreService を一切呼ばない (Claude で getPassword が呼ばれない)。
- autotest: 未ログインなら 3 つ目が `CLAUDE_LOGIN_REQUIRED` を受けて PASS。

## 3. 完了条件 (実装者が確認)

1. `npm --prefix arschat-providers run build` / `npm --prefix arschat-chat run build` / `npm --prefix arschat-agents run build` が tsc エラー 0。
2. `npm --prefix arschat-chat test` と `npm --prefix arschat-agents test` が全 green。
3. node_modules・lib・electron-app の生成物は編集しない。コミットしない。
4. 本物の `claude` (ユーザーのログイン) を起動するテストを書かない。テストは spawn をモックする。

## 4. やらないこと

- ArsChat から `claude auth login` / `/login` を起動したり、OAuth・トークンを読んだり保存したりすること。
- `~/.claude/.credentials.json` など CLI の認証ファイルを ArsChat が読むこと。
- API キー方式を設定で選べるように残すこと。

## 5. レビュー 1 回目の指摘への対応 (追補)

公式ドキュメント (code.claude.com/docs/en/cli-reference) によると `claude auth status` の `authMethod` は
`none` / `claude.ai` / `oauth_token` / `api_key` / `api_key_helper` / `third_party` のいずれか。

1. **サブスクリプション以外の認証を拒否する**: `loggedIn === true` でも、`authMethod` が `claude.ai` か `oauth_token` の時だけ「使える」とする。
   - `api_key` / `api_key_helper` / `third_party`、および未知の文字列・欠落は「サブスクリプションではない」とし、`-p` を起動しない。
   - 新定数 `CLAUDE_SUBSCRIPTION_REQUIRED` (common/cli-agents.ts):
     `'Claude Code が API キーまたは他社クラウドの認証で設定されています。ArsChat は Claude のサブスクリプションのログインでのみ Claude Code を動かします。Claude Code の設定から API キー (apiKeyHelper や env の ANTHROPIC_API_KEY) を外し、ターミナルで `claude` → /login でログインしてください。'`
   - `claudeLoggedIn` は `Promise<'subscription' | 'logged-out' | 'other-auth' | undefined>` を返す形に変えてよい (名前も `claudeAuth` 等に変えてよい)。
   - check: `other-auth` → `{ available: false, loggedIn: true, message: CLAUDE_SUBSCRIPTION_REQUIRED }`。request: `other-auth` → `{ text: CLAUDE_SUBSCRIPTION_REQUIRED }`。
2. **確認と本体の作業ディレクトリを揃える**: request では作業ディレクトリ (設定値、または既定の `<config>/arschat/cli-agents`) を先に決めてから、`auth status` をその cwd で起動する (プロジェクトの `.claude/settings.json` が両方に同じように効くように)。check も同じ作業ディレクトリ解決を使う (作業ディレクトリ解決を小さなメソッドに切り出す)。作業ディレクトリが用意できない時の既存エラーは維持。
3. テスト追加: authMethod 6 種 + 未知値 + 欠落の各ケース (claude.ai / oauth_token のみ `-p` 起動)、auth status と `-p` の spawn の cwd が一致すること。
