---
scope: spec
milestone: ms-8
---
# ms-8 SPEC: 会話の途中を書き換え・続き・分岐で追い込めるようにする

## 背景・なぜこのMSが必要か

M6 (ms-7) までで、メッセージにホバーで出るアクションは **コピー・再生成・削除** の 3 つに揃った。しかし旧 ArsChat には **編集・続きを生成・ここから分岐** の 3 つが加わっていて、これらが「AI との会話は一発勝負ではなく、途中で書き換えて追い込む道具」という体験の中核を担っていた。

今の Theia 版は「気に入らなかったら削除して全部やり直し」しかできず、途中の 1 メッセージだけ直したい、続きだけ引き出したい、別ルートも試したい、といった追い込み方が全部使えない。ms-7 まで整えた見た目のチャットアプリ水準に対して、操作の深さが追いついていない状態。

このMSで 3 動作を移植し切ると、旧 ArsChat のユースケースが Theia 版でも初めて成立する (= Phase 1 の M6 → M7 移行の実質的な意味)。

## 解決すべき問題

| 事象 | 内容 |
|---|---|
| 編集不可 | 送信後のメッセージ本文を書き換えられない (誤字修正・プロンプト微調整も削除→再入力しか手が無い) |
| 続き引き出し不可 | assistant の回答が途中で止まったり、もう少し続けてほしい時に「続けてください」を毎回自分で打つ必要がある |
| 分岐不可 | 同じ文脈から別のプロンプトを試したい時に、現在のセッションを壊すか丸ごとコピペするしか手段が無い |
| 自動検証の空白 | 3 動作の JSDOM ユニットテストも実機自動検証も無く、回帰が発生しても気付けない |

## 設計方針 (判断軌跡)

### 1. 編集は「ユーザー発言=自動再生成、assistant 発言=その場保存のみ」の非対称にする
- 理由: ユーザーメッセージを書き換えた瞬間、続きの assistant 返答は古い前提に基づいた出力になり、そのまま残すと文脈が壊れる。ChatGPT / Claude web と同じく「編集確定 → 以降の turn を破棄して再送」を自動で走らせる方が追い込み UX が滑らか (今回のユーザー判断で確定)。
- 一方、assistant 発言の編集は「AI の出力を人が手直しして残す」という別種の操作で、直後の再生成は意味を持たない (自分自身の直後には何も無い)。単純に本文を書き換えて保存する。
- 却下案 A (両方保存のみ): 旧 ArsChat 準拠だが「編集 → 手動で再生成を押す」の 2 手が必要で、追い込みのテンポが悪い。
- 却下案 C (編集確定時に保存 / 再生成の 2 ボタン): 選択肢を毎回出すのは冗長。判断を UX 側で吸収する。

### 2. 3 動作すべて `RequestTreeModel` の直接操作 + `chatSessionStore` 明示保存で実装する
- 理由: 既に `deleteMessage` / `regenerate` が使っている `dropTurnFromModel` + `persistCurrentSession` の経路が確立済み (`arschat-chat-widget.tsx:789-827`)。同じ層に足すのが最短で、Theia 純正 chat のイベント経路 (auto-save via `onDidChange`) と衝突しない。
- 却下案: `ChatService` に新規 API を足す = Theia 上流に踏み込む必要があり、Phase 1 の「Theia 上に薄く乗せる」方針に反する。

### 3. 続き = 「隠しユーザー turn を挿入して再送」で表現する (LLM API の continuation は使わない)
- 理由: 旧 ArsChat と同じく `続けてください` を差し込んで送るだけで、プロバイダ非依存 (OpenAI / Anthropic / LM Studio / Unsloth 全部で同じ動きになる)。API レベルの continuation は provider ごとに実装差が大きく、ms-8 の scope を越える。
- 隠しユーザー turn は表示・履歴保存にも残す (会話ログに「続けてください」が現れるが、それは意図した挙動で、後で読み返した時に「なぜここで続きが差し込まれたか」の痕跡になる)。

### 4. 分岐 = 「対象メッセージまでの request tree slice を新セッションとして生成、そこへ切替」で表現する
- 理由: 旧 ArsChat の `handleBranchMessage` と等価な体験 (`[分岐] <元タイトル>` として左パネルに新セッションを積み、そのまま開く)。ユーザーは今のセッションを壊さずに別ルートを試せる。
- 新セッションのタイトルは元セッションの最初のユーザー発言 50 文字 + `[分岐] ` prefix。ms-4 で入れた「履歴パネル」に自動で現れる。

### 5. 検証は Jest ユニット + ARSCHAT_M7_AUTOTEST (M6 の枠組みを踏襲) で二重に取る
- 理由: ms-7 で `ARSCHAT_M6_AUTOTEST` の枠組みが既に走っている (`arschat-chat-widget.tsx` に組み込み済み)。同じ発火 flag で M7 モードを追加すれば、M6 の検証を壊さず M7 の 3 動作を実機で自動検証できる。
- Jest は state 遷移 (編集 open/save/cancel / 続き挿入 / 分岐 slice) を JSDOM 上でカバー、autotest は実 Theia 起動でホバー UI が出る & クリックで期待の DOM 変化が起きることをカバー。役割分担を分ける。

## スコープ

### やる
- 編集: user / assistant 両方の本文を書き換え可能にする。user 側は確定と同時に以降の turn を破棄して再送 (自動再生成)、assistant 側は保存のみ。
- 続きを生成: assistant 発言の下から `続けてください` を隠しユーザー turn として挿入し、通常の送信パイプラインで再送。
- 分岐: 対象メッセージ (user/assistant 問わず) までを含む新セッションを `[分岐] ...` タイトルで生成し、そちらに切り替える。
- 上記 3 動作の Jest テスト追加 (`arschat-chat-widget.test.ts` に節を足す)。
- `ARSCHAT_M7_AUTOTEST` 環境変数で 3 動作を実機自動検証する枠組み。
- BUILD_NOTES に実機確認結果を追記 (M6 と同じ運用)。

### やらない (別 MS or 後回し)
- LLM API レベルの continuation (assistant turn を継続させる provider ネイティブ API) — ms-8 では隠しユーザー turn 方式に限定。将来必要なら別 MS。
- 分岐した会話のマージ (git-like な branch merge) — 使いこなしが難しく、今 phase のユースケースに含まれない。
- 編集履歴 (edit history / undo redo)。編集は「上書き保存」で完結し、旧版を追える仕組みは持たない。
- 添付画像やツール呼び出しの編集 (テキスト本文の編集のみ扱う。画像プレビュー UX は ms-10 で別途)。
- 見た目のアクションアイコン刷新 (旧 ArsChat の svg をそのまま流用する。デザイン再検討は別レビュー MS で)。

## 受入条件

1. assistant メッセージにホバーすると **編集 / 続きを生成 / 分岐** の 3 ボタンが (既存の コピー / 再生成 / 削除 に加えて) 表示される。
2. user メッセージにホバーすると **編集 / 分岐** の 2 ボタンが (既存の コピー / 削除 に加えて) 表示される (続き / 再生成 は user 対象では出さない)。
3. **編集**: ボタン押下でメッセージ本文が編集可能な textarea になり、確定で本文が更新される。キャンセルで元に戻る。
4. **編集(user)**: 確定した瞬間、そのメッセージ以降の turn (対象含む後続の request/response ペア) が破棄され、編集後の本文で自動再送される。送信中は sending スピナー等、既存 send() と同じ UI 表示になる。
5. **編集(assistant)**: 確定した瞬間、本文だけが上書きされ、再送は走らない。永続化 (chatSessionStore) される。
6. **続き**: assistant メッセージの下から続きボタンを押すと、直後に `続けてください` の user turn が差し込まれ、通常の送信パイプラインで再送される。差し込み後は履歴にも残る。
7. **分岐**: 対象メッセージまでを含む新セッションが `[分岐] <元タイトル>` (50 文字上限) で生成され、履歴パネルに追加され、そちらのタブに自動切替される。元セッションは壊れない。
8. すべての操作後、`chatSessionStore` に反映されており、Theia を再起動しても状態が保たれる。
9. `arschat-chat-widget.test.ts` に 5 動作 (編集 open/save (user 再送) / 編集 save (assistant 保存のみ) / 続き挿入 / 分岐生成 / 編集 cancel) の Jest テストが追加され、`yarn workspace @arschat/chat test` が全 green。
10. `ARSCHAT_M7_AUTOTEST=1` で起動すると、3 動作 (編集・続き・分岐) がホバー UI 経由で発火して DOM が期待通りに変化することを自動検証し、合否を出す。
11. `BUILD_NOTES.md` に e-XX (このMSの起票 entry) の実機確認結果が追記される。

## 実装順序のヒント

1. **編集モード UI + assistant 保存のみ** — MessageBubble ライクな edit textarea を `renderMessageActions` の周辺に足し、`editingMessageId` 状態を widget に足す。assistant 保存パスから作り、`chatSessionStore` 反映まで通す。
2. **user 編集の自動再生成** — 編集確定時に対象以降の turn を `dropTurnFromModel` + `messages.filter` で切り、編集後の本文を `inputValue` に入れて `send()` (既存 regenerate と同じパターン)。
3. **続きを生成** — assistant 用に `continueMessage(msg)` を足し、`inputValue = '続けてください'` → `send()` で通常経路を通す。draft の退避/復元は regenerate と同じ扱い。
4. **分岐** — `branchMessage(msg)` で対象までの request slice を作り、`chatSessionStore` に新セッション登録、`chatService.createSession` 経由でモデル作成、`uiService` で切替。
5. **Jest ユニットテスト追加** — `arschat-chat-widget.test.ts` に 5 動作の state 遷移テスト。
6. **ARSCHAT_M7_AUTOTEST 実装** — M6 の autotest コードを参考に M7 モードを追加、3 動作の end-to-end 検証。
7. **BUILD_NOTES 追記 + 動作記録**。

## 関連

- 直前のMS: `ms-7` M6 IDE再希釈+チャットUI仕上げ (SPEC: `ms-7-spec-m6-ide再希釈-チャットui仕上げ`)
- 移植元: `C:\Users\takep\source\ArsChat\src\renderer\components\MessageBubble.tsx` (アクションボタン UI)、`ChatWindow.tsx:520-591` (handleContinue/Branch/Edit ハンドラ)
- 実装接続点: `arschat-chat\src\browser\arschat-chat-widget.tsx:720-812` (既存 copy/regenerate/delete のパターン)、`arschat-request-tree.ts` (`removeRequestFromModel`)
