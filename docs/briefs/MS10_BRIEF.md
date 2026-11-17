# MS10 実装ブリーフ: 添付画像のプレビューと個別削除・自動縮小

> 調査担当 (Sonnet) 作成。コード変更・コミットは行っていない。実装は Opus に引き継ぐ想定。
> 参照 SPEC: `docs/specs/ms-10-spec-添付画像のプレビューと個別削除-自動縮小.md`

## 0. 最重要の発見 (SPEC の前提を覆す)

SPEC 冒頭は「送信前に何が添付されているか見えず、個別削除もできない」という前提で書かれているが、**現行コードには (A) サムネイル一覧表示と (B) 個別削除ボタンが既に実装済み**である。導入は ms-4 の本実装コミット `f0c413b`（"自前チャットWidget本実装+セッション永続化+履歴パネル"）まで遡る。実機で未確認・未テストなだけで、機能自体は存在する。

- `arschat-chat-widget.tsx` L571-584: `pendingImages.length > 0` のときだけ入力欄直上に `.arschat-attachments` 行を描画し、各画像に `×` の `.arschat-attachment-remove` ボタンが付く。添付 0 件で行ごと非表示（SPEC 受入条件 4 を満たす）。
- L620-623: `removePendingImage(index)` が `pendingImages.splice(index, 1)` するだけの単純な実装（SPEC 受入条件 2「他の添付と入力中テキストは維持される」を満たす。`inputValue` には触れない）。
- CSS も `style/index.css` L268-317 に一式ある（`.arschat-attachments` / `.arschat-attachment` / `.arschat-attachment-thumb`（64×64 max）/ `.arschat-attachment-remove`（右上に浮かぶ丸い ×））。

つまり **ms-10 で本当に新規実装が必要なのは (C) 自動縮小のみ**。(A)(B) は「壊れていないか確認 + Jest テスト追加 + 実機確認」が主な作業になる。この事実は SPEC 作成時点（AI 推測）で見落とされていた可能性が高く、実装者は最初にこの前提のズレを踏まえてスコープを再確認すべき。

## 1. 現状分析

### 1.1 添付データ構造 (`arschat-chat-widget.tsx`)

```ts
// L62-69
interface PendingImage {
    data: string;        // base64 (no data: prefix)
    mimeType: string;
    name: string;
    previewUrl: string;  // data: URL (プレビュー用、= `data:${mimeType};base64,${data}`)
}
```
- `protected pendingImages: PendingImage[] = [];` (L175) — widget インスタンスの生フィールド。React state ではなく Theia `ReactWidget` の `this.update()` (= `super.update()` 呼び出しで再描画) パターンに乗っている。

### 1.2 添付の受け口

- `addImageFile(file: File)` (L595-609): `FileReader.readAsDataURL` で data URL 化 → base64 部分を切り出して `pendingImages.push(...)` → `this.update()`。
- `handlePaste` (L691-705): クリップボードの `image/*` アイテムを `addImageFile` へ。
- `handleDrop` (L707-717) / `handleDragOver` / `handleDragLeave` (L719-734): ドラッグ&ドロップ受け口 + `dragActive` ハイライト (`#arschat-chat-root.arschat-drag-active`, CSS L319-322)。
- `removePendingImage(index)` (L620-623): 個別削除（既存）。

### 1.3 送信経路 (添付が実際にリクエストへ載るまで)

`send()` (L752-843) の該当部分:

```ts
// L767-771
const attachedPreviews = this.pendingImages.map(img => img.previewUrl);
const variables: AIVariableResolutionRequest[] = this.pendingImages.map(img =>
    ImageContextVariable.createRequest({ data: img.data, mimeType: img.mimeType, name: img.name })
);
const imagesForModel = [...this.pendingImages];
```
これは同期処理。`variables` はそのまま `chatService.sendRequest(sessionId, { text, displayText, variables })` (L795-798) に渡り、Theia AI の `ImageContextVariable` としてマルチモーダルパスに載る。`attachedPreviews` は送信直後に push する `userMessage.images` (L777-779) として自分の吹き出しの再表示に使われるだけ（サーバへは行かない）。

`imagesForModel` は現状 `console.log` の件数表示 (L794) にしか使われておらず、事実上未使用の変数（縮小を挟むならここが自然な差し込み点になる）。

`ImageContextVariable` 型定義 (`node_modules/@theia/ai-chat/lib/common/image-context-variable.d.ts`):
```ts
interface ImageContextVariable {
    name?: string;
    wsRelativePath?: string;
    data?: string;      // base64 (data: プレフィックス無し)
    mimeType?: string;
}
```
`createRequest(content: ImageContextVariable): ImageContextVariableRequest` で `AIVariableResolutionRequest` に包む。data は常に **base64 (プレフィックス無し)**。ファイルパス参照（ドロップ由来で on-demand 解決するケース）もあるが、現行 `addImageFile` は常に事前読み込みして `data` を埋める方式なので、arschat-theia 側は基本 pre-processed 一択。

再編集時の復元は `pendingImagesFromVariables` (L653-679) が `ImageContextVariable.parseRequest` で逆変換して行っている（既存の永続化済みセッションから `PendingImage[]` を再構築）。ここは (C) の実装が **送信時にのみ縮小後データを書き込む** 設計であれば影響を受けない（一度縮小されて永続化された画像は、そのまま縮小済みとして再編集時にも復元されるだけ）。

### 1.4 IME ゲート (`update()` override, L284-303)

```ts
override update(): void {
    if (this.composing) {
        this.pendingUpdateWhileComposing = true;
        return;
    }
    super.update();
}
```
`composing` は入力欄の IME 変換中のみ true になるフラグ（`onInputCompositionStart`/`flushComposingUpdate` 経由、L1374-1381, L297-303）。`removePendingImage` や `addImageFile` は普通に `this.update()` を呼ぶだけで、この既存ゲートに自動的に乗る（新規のゲート実装は不要）。

ただし注意点が一つ: × ボタンクリックは通常テキストエリア外の要素なので `composing` が true のまま起きることは稀だが、理論上は「IME変換中に (別ウィンドウの) ×ボタンをクリック」→ その瞬間 `update()` が抑制される、というケースがありうる。実際は × ボタンをクリックする直前にテキストエリアが `blur` し `flushComposingUpdate()` が先に走るため（React のフォーカス移動順序上、mousedown→blur→click の順）、実害はほぼ無いと考えられるが、テストで「composing 中に removePendingImage を呼んでも取りこぼさない」ケースを 1 本入れておくと安全（`pendingUpdateWhileComposing` が正しく flush されることの確認）。

### 1.5 既存テスト (`arschat-chat-widget.test.ts`, 1306 行)

- 添付・画像プレビュー・個別削除・ドラッグ&ドロップ・貼り付け・resize のいずれについても**専用テストは 0 件**。`pendingImages`/`ImageContextVariable` に触れているのは編集系テスト (L1095-1130: `saveUserEdit resends the original image variables and restores draft images`) のみで、`pendingImages` を直接 `asAny(widget).pendingImages = [...]` にセットして間接的に検証している。
- テストパターン: `asAny(widget)` ヘルパー (L496-498, `w as any` で protected メンバへアクセス) を多用。`render(widget.render())` (`@testing-library/react`) で DOM を取得し `container.querySelector(...)` でクラス名を確認するスタイル (例: L1145-1148)。`fireEvent` でキー入力/クリックをシミュレート。
- DI コンテナは `ContainerModule` + 手書きの fake サービス（`ChatService`/`ChatSessionStore`/`ProviderSwitchService` 等をすべて最小スタブで束ねる、L96 以降）。widget 自体は `container.get(ArschatChatWidget)` して生成するはず（ファイル冒頭 100 行の外、`beforeEach` 続きに存在。今回は未確認だが同ファイル内の既存テストが前提としている構成に倣えば十分）。
- jest 設定 (`arschat-chat/configs/jest.config.ts`): `testEnvironment: 'jsdom'`、`preset: ts-jest`。**`canvas` / `jest-canvas-mock` パッケージは `package.json` の devDependencies に無い**（確認済み）。jsdom は `HTMLCanvasElement.getContext('2d')` を実装していないため、素の canvas 描画コードは jsdom 上で例外を投げるか no-op になる。→ §5 テスト方針で詳述。

### 1.6 `style/index.css` の作法

- クラス名は必ず `arschat-` プレフィックス、BEM 的な `arschat-<component>-<part>` 命名 (`arschat-attachment-thumb`, `arschat-attachment-remove` 等)。
- セクション区切りコメント `/* ---- <日本語 or 英語の見出し> ---- */` で機能ブロックを区切る（例: L318 `/* ---- drag & drop overlay ---- */`）。
- 色は生の hex ではなく `var(--theia-xxx, <fallback>)` を第一候補にする（例: `var(--theia-errorForeground, #c0392b)`）。
- 今回 (C) は純粋にロジック追加なので **新規 CSS は基本不要**（既存の `.arschat-attachment-thumb` の `max-width/max-height: 64px` は表示上のクランプであり、実データの縮小とは無関係）。

## 2. 移植元 (ArsChat, Electron+React) の添付 UX

### 2.1 実装箇所

`C:\Users\takep\source\ArsChat\src\renderer\components\ChatWindow.tsx`

- 添付は **単一画像のみ**: `const [pendingImageBase64, setPendingImageBase64] = useState<string | null>(null);` (L73)。arschat-theia の複数添付 (`PendingImage[]`) より機能が後退している。
- プレビュー UI (L1356-1376):
  ```tsx
  {pendingImageBase64 && (
    <div className="mb-2 p-2 bg-aria-surface rounded-xl border border-aria-border">
      <div className="flex items-start justify-between gap-2">
        <img src={`data:image/png;base64,${pendingImageBase64}`} alt="キャプチャ画像"
             className="rounded-lg max-w-full max-h-36 object-contain" />
        <button onClick={() => setPendingImageBase64(null)}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/20 text-aria-text-muted hover:text-red-400 transition-colors"
                title="添付を削除" disabled={isStreaming}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )}
  ```
  - サムネイルは `max-h-36`（≒144px）と大きめ、カード全体を枠で囲む見た目。
  - × は SVG の X アイコン（テキストの `×` ではない）、ホバーで赤系にハイライト。
  - `isStreaming` 中は削除ボタンを disabled にしている（= 送信中は添付を弄れないようにするガード）。
- 画像の取得経路はクリップボード貼り付け・システムクリップボード読み取り (`window.arsChatAPI.readClipboardImage`)・画面キャプチャ (`onCapturedImage`) の 3 系統。ドラッグ&ドロップは見当たらない。

### 2.2 自動縮小の有無

**存在しない。** `ChatWindow.tsx` / `main/index.ts` / `preload.ts` を含め、`canvas`・`resize`・`toDataURL`・`1568` 等のキーワードで検索したが、画像添付を縮小する処理は一切無かった（`main/index.ts` にヒットした `canvas` はスプラッシュ画面のアニメーション用途で無関係、`ipcMain.on('terminal:resize', ...)` はターミナルのリサイズで無関係）。原寸 base64 PNG をそのまま送っている。

### 2.3 手本にする/しない判断

| 要素 | 判断 | 理由 |
|---|---|---|
| プレビューをカード状に囲み、入力欄の直上に配置 | **手本にする（すでに arschat-theia でも同じ配置）** | SPEC の設計方針 §1 と一致。位置取りは踏襲済みなので変更不要。 |
| サムネイルサイズ (144px 相当) | **手本にしない** | 現行 arschat-theia は 64px でよりコンパクト。複数添付を横並びで見せる ms-10 の意図（一覧性）には 64px の方が適する。144px は単一画像前提の UI。 |
| SVG の × アイコン + ホバーで赤くハイライト | **参考程度**（必須ではない） | 現行はテキストの `×` + 常時赤背景の丸ボタンで既に視認性は十分。SVG 化は見た目の一貫性向上にはなるが ms-10 のスコープ外（「やらない」に近い polish）。着手するなら別 issue。 |
| `isStreaming` 中は削除ボタンを disabled | **要検討・部分的に手本にする** | 現行 arschat-theia の `send()` は同期的に `pendingImages` を空にしてから送信するため（L782）、送信開始後は `pendingImages` 自体が空になり削除ボタンは表示されなくなる（＝実質同じガードが構造的に成立している）。ただし (C) 縮小処理を `send()` 内の非同期化ポイントに挟むタイミング次第では「クリック直後、縮小完了までの一瞬」に UI 上まだ添付が見えている可能性があるため、後述 §4 の実装方針で「送信開始と同時に pendingImages を空にする」現行の型を崩さないことを推奨。 |
| **単一画像のみという制約** | **手本にしない（重要）** | 複数添付は arschat-theia のほうが優れている。SPEC の「移植元で確立していた」という記述は UI の見た目（カード + ×）についての話であり、データモデル（単一 vs 複数）まで真似る必要は無い。ms-8 の教訓（移植元にも欠陥がある）がここでも当てはまる。 |
| 画像縮小 | **手本にできない（存在しないため）** | ms-10 の (C) は arschat-theia 側の完全新規実装。移植元調査からは「縮小しなくても動いてはいた」という消極的事実しか得られない。 |

## 3. 実装方針

### (A) 送信前サムネイル一覧

**現状ですでに実装済み。** 追加実装は基本不要。やることは:
1. 実機確認（貼り付け 1 枚・複数枚・ドラッグ&ドロップそれぞれでサムネイルが並ぶか）。
2. Jest テストの追加（§5）。
3. 気になる点があれば軽微な調整のみ（例: サムネイル間の `gap` や `max-width` の微調整）— ただし SPEC の「やらない」に無い変更は避ける。

### (B) 個別削除

**現状ですでに実装済み。** `removePendingImage(index)` (L620-623) は `pendingImages.splice(index, 1); this.update();` のみで、`inputValue` 等の他状態には触れない。受入条件「他の添付と入力中テキストは維持される」は構造的に満たされている。
1. Jest テストの追加（§5）。
2. 実機確認。

### (C) 送信時自動縮小 (長辺上限 目安1568px, 確認ダイアログ無し) — 新規実装

**方針: 純粋関数（サイズ計算）とブラウザ API 呼び出し（実際の描画）を分離する。** これは jsdom 環境でのテスト容易性のためだけでなく、責務分離としても妥当。

#### 3.1 差し込み位置

`send()` (L752-843) の中、`pendingImages` を読む最初の場所（L767-771）の **直前** に、非同期の縮小ステップを挟む。現状の該当行を置き換える形:

```ts
// 現状 (L767-771, 同期):
const attachedPreviews = this.pendingImages.map(img => img.previewUrl);
const variables = this.pendingImages.map(img => ImageContextVariable.createRequest({...}));
const imagesForModel = [...this.pendingImages];

// 変更後 (概念):
const originalImages = [...this.pendingImages];
this.pendingImages = [];            // 送信着手と同時に入力欄直上のプレビュー行を消す（現行の「即クリア」挙動を維持）
this.inputValue = '';               // (既存の並びを維持しつつ、画像側も即クリア)
this.update();                      // ここで一旦再描画（添付行が消え、送信中の見た目になる）

const resizedImages = await Promise.all(originalImages.map(img => this.resizeImageIfNeeded(img)));

const attachedPreviews = resizedImages.map(img => img.previewUrl);
const variables = resizedImages.map(img => ImageContextVariable.createRequest({ data: img.data, mimeType: img.mimeType, name: img.name }));
const imagesForModel = resizedImages;
```

- 送信ボタンを押した瞬間に添付行を消す現行の「即時性」を壊さないため、**`pendingImages` のクリアと `inputValue` のクリアは縮小処理の前に行う**（今の L781-782 相当の処理を繰り上げる）。縮小完了を待ってからクリアすると「送信ボタンを押したのに添付が一瞬残る」体感の遅延が出る。
- `userMessage`（吹き出し）の push は縮小完了後に行う（`attachedPreviews` が縮小後データに依存するため）。つまり「送信ボタン押下 → 添付行は即消える → コンマ数百 ms 後にユーザー吹き出しが出る」という体感になる。大きい画像を複数枚添付した場合は数百ms〜1秒程度のラグが出うる点は許容としてよい（SPEC は「確認ダイアログを出さない」ことだけを要求しており、無音の遅延は許容範囲）。気になるならユーザー吹き出しの push だけ即座に行い `images` を `undefined` のまま表示 → 縮小完了後に差し替える、という二段階にする手もあるが、複雑化するので **まずはシンプルな「縮小完了を待ってから吹き出しを出す」で実装し、実機確認で体感が悪ければ二段階化を検討** という順序を推奨。

#### 3.2 縮小ロジック本体

新規メソッド案（`arschat-chat-widget.tsx` の「images」セクション、L593 以降に追加）:

```ts
/** 長辺上限 (目安1568px)。Anthropic Vision の実効解像度上限に合わせた値。 */
const MAX_IMAGE_LONG_EDGE = 1568;

/** 純粋関数: 縮小が必要か・必要なら縮小後の寸法を計算する。副作用なし、jsdom でも普通に単体テスト可能。 */
export function computeResizeTarget(
    width: number, height: number, maxLongEdge: number = MAX_IMAGE_LONG_EDGE
): { width: number; height: number; needsResize: boolean } {
    const longEdge = Math.max(width, height);
    if (longEdge <= maxLongEdge || longEdge === 0) {
        return { width, height, needsResize: false };
    }
    const scale = maxLongEdge / longEdge;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        needsResize: true
    };
}
```
このファイルの末尾 or 専用ファイル `arschat-image-resize.ts` に切り出すことを推奨（後述 §5 参照。widget.tsx にべた書きすると import だけのテストが書けない）。

副作用を持つ側（widget のメソッド、または同じ新規ファイルの `export` 関数）:

```ts
protected async resizeImageIfNeeded(img: PendingImage): Promise<PendingImage> {
    // アニメーション GIF は canvas 経由だと 1 フレームの静止画になり動きが失われるため、
    // 縮小対象から除外して原寸のまま送る (SPEC「高度な画像処理はやらない」に整合)。
    if (img.mimeType === 'image/gif') {
        return img;
    }
    const dims = await this.loadImageDimensions(img.previewUrl); // new Image() で計測
    const target = computeResizeTarget(dims.width, dims.height);
    if (!target.needsResize) {
        return img;
    }
    return this.drawResizedImage(img, dims, target);
}
```

`loadImageDimensions` / `drawResizedImage` は `new Image()` + `<canvas>` を使う薄いラッパー（`Image.onload` → `canvas.width/height = target` → `ctx.drawImage(image, 0, 0, target.width, target.height)` → `canvas.toDataURL(img.mimeType)` から新しい `data`/`previewUrl` を作る）。JPEG の場合は `toDataURL('image/jpeg', 0.92)` 程度の quality 指定を検討してよいが、SPEC は圧縮品質について何も要求していないため、**まずは寸法縮小のみ（quality はブラウザデフォルト）で十分**。

#### 3.3 対象範囲・型注意

- `PendingImage.data`/`mimeType` を書き換えた新しいオブジェクトを返す（既存オブジェクトを in-place mutate しない。再編集時の巻き戻し等で古い参照が残っている可能性があるため、常に新規オブジェクトを返すほうが安全）。
- `name` はそのまま維持（拡張子と実データの mimeType が食い違う可能性はあるが、SPEC のスコープ外）。
- 上限以下の画像は無加工で返す（受入条件 3 の「上限以下の画像は無加工」を満たす。`resizeImageIfNeeded` が早期 return するだけで担保される）。

## 4. 罠・注意点

1. **IME ゲートとの共存**: (C) の縮小処理自体はテキストエリアの composition と直接絡まないため大きな懸念は無いが、`send()` の非同期化ポイントが増える（`await Promise.all(...)` が新たに挟まる）ため、縮小中に他の `update()` 呼び出し（例: ストリーミング中の別リクエスト、モデル切り替え等）が来ても `composing` ゲートは従来どおり機能する。新規に手を入れる必要は無い。ただし `sending` フラグは `send()` 冒頭 (L757) で立てたままなので、縮小中も「送信中」として二重送信は防止されている（変更不要、確認のみ）。

2. **controlled 再描画のタイミング**: §3.1 で述べたとおり、`pendingImages` クリアと `userMessage` push の間に await が入る。この間に `startNewSession()` や `loadSession()` が呼ばれる（履歴パネルからセッション切り替え）と、`this.messages` が丸ごと差し替わった後に縮小完了 → 古い `userMessage` を新しい `this.messages` に push してしまう不整合が起きうる。既存の `send()` にも同種の懸念（`invocation.responseCreated` 待ちの間にセッション切り替えされたら？）は既にあり、現行実装でも明示的にガードされていない模様（`abortIfSending()` は `startNewSession`/`loadSession` から呼ばれ `sending=false` にするだけで、進行中の `send()` の続きは止まらない）。**(C) 実装でこの既存の潜在バグを深掘りする必要は無いが、少なくとも「縮小 await の前後で `this.sessionId` が変わっていないか」を確認して不一致なら早期 return する程度のガードは、新たに増える await ポイント分だけリスクが増すので検討に値する**（must ではなく nice-to-have として brief に記録）。

3. **送信レース (二重クリック)**: `sending` フラグは同期的に立つ (L757) ため、縮小処理中にユーザーが送信ボタンを連打しても `send()` 冒頭の `if (... || this.sending) return;` で弾かれる。問題なし。

4. **大画像のメモリ**: `addImageFile` は貼り付け/ドロップの時点で `FileReader.readAsDataURL` により base64 化済み（既存、変更なし）。(C) はその後さらに `new Image()` でデコードし `canvas` に描画するため、一時的に「元画像のデコード後ビットマップ + 縮小後ビットマップ + 縮小後 base64 文字列」が同時にメモリ上に存在する。数十MB級の写真を複数枚同時に貼り付けた場合、一瞬のメモリスパイクは避けられない。SPEC は「原寸が必要なユースケースは想定利用に無いため切り捨てる」と明言しているので、極端なケースへの防御的実装（例: 事前にファイルサイズ上限を設けて弾く）は **スコープ外**。ただし `Promise.all` で全画像を同時並列処理するため、5枚以上の大きい画像を同時添付した場合はスパイクが重なる。心配なら `for...of` で順次処理に変えて並列度を絞る選択肢もあるが、まずは `Promise.all` のシンプルな実装で良く、実機確認で体感が悪ければ直列化を検討。

5. **アニメーション GIF**: §3.2 で触れたとおり canvas 経由の縮小は必ず 1 フレームの静止画になる。`image/gif` は縮小対象から除外する実装にする（もしくは「GIF は解像度が元々小さいことが多いのでそもそも縮小対象に該当しないことが多い」という消極的な理由でスルーする手もあるが、上限を超える大きい GIF を貼った場合に動きが壊れて気づきにくいので、**明示的に除外**する方が安全）。

6. **`toDataURL` の mimeType 対応**: canvas は `png`/`jpeg`/`webp` 以外の type 指定では自動的に `image/png` にフォールバックする（ブラウザ実装依存だが仕様上そう定義されている）。`img.mimeType` をそのまま `toDataURL` に渡す実装で問題ないが、結果的に mimeType が変わる（例: 元が `image/bmp` なら縮小後は事実上 `image/png` になる）ケースがある。`PendingImage.mimeType` は **実際に `toDataURL` へ渡した type ではなく、返ってきた data URL から読み取った実際の mimeType** で更新するのが安全（`data:image/png;base64,...` の `image/png` 部分をパースし直す）。

7. **既存 77 件のテストを壊さない**: `send()` の中身を変更するため、既存の送信フロー系テスト（`saveUserEdit` が内部で `send()` をモック差し替えして呼んでいるテスト群など、L1079, L1114 等）は `send()` 自体をモックしているので直接の影響は無いはずだが、`send()` の実処理を検証する既存テスト（もしあれば）は `resizeImageIfNeeded` のモックが必要になる可能性がある。実装時に `npm test` を必ず通すこと。

## 5. テスト方針

### 5.1 (A)(B) 既存機能のテスト（新規追加）

`render(widget.render())` + `container.querySelector` パターンを踏襲。

- 「`pendingImages` が空のとき `.arschat-attachments` が描画されない」
- 「`pendingImages` に2件セットすると `.arschat-attachment` が2つ描画され、各 `img.arschat-attachment-thumb` の `src` が `previewUrl` と一致する」
- 「`.arschat-attachment-remove` を `fireEvent.click` すると、`pendingImages` からその1件だけが消え、他の添付・`inputValue` は変化しない」— `asAny(widget).pendingImages = [...]; asAny(widget).inputValue = '下書き';` としてから button クリック → `asAny(widget).pendingImages` と `asAny(widget).inputValue` を検証。
- `addImageFile` は `File`/`FileReader` に依存するため、jsdom の `FileReader` 実装（jsdom は `FileReader.readAsDataURL` を一応サポートしている）でそのまま動くはずだが、確実性を優先するなら `asAny(widget).addImageFile` を直接呼ぶのではなく、`readFileAsDataUrl` をテスト側で spy/mock して `resolve('data:image/png;base64,AAAA')` を返す形にすると安定する。

### 5.2 (C) 自動縮小のテスト — jsdom に canvas が無い問題への対処

**確認事実**: `arschat-chat/package.json` の devDependencies に `canvas` も `jest-canvas-mock` も無く、`jest.config.ts` の `testEnvironment` は素の `jsdom`。jsdom は `HTMLCanvasElement.prototype.getContext` を実装していない（呼ぶと `null` を返すか、実装によっては何もしない）ため、`ctx.drawImage(...)` のような描画コードをそのまま実行するテストは書けない。

**方針: 3層に分けてテスト容易性を作る。**

1. **純粋関数 `computeResizeTarget(width, height, maxLongEdge)` を独立ファイル (`arschat-image-resize.ts` 案) に切り出し、通常の `describe/it` で全面的にテストする。** ここが最も重要なロジック（上限判定・アスペクト比維持・四捨五入）であり、canvas 不要で 100% テストできる。ケース例:
   - 横長画像 (2000x1000) → (1568, 784) に縮小、アスペクト比維持
   - 縦長画像 (1000x2000) → (784, 1568)
   - ちょうど上限 (1568x1568) → 無加工 (`needsResize: false`)
   - 上限未満 (800x600) → 無加工
   - 極端な正方形巨大画像 (10000x10000) → (1568, 1568)
   - 0 除算ガード (`width` or `height` が 0 のとき例外を投げない)

2. **`resizeImageIfNeeded`/`drawResizedImage` 相当の副作用コードは、`document.createElement`/`Image`/canvas 呼び出しを jest でモックして、「正しい引数で正しく呼ばれるか」「戻り値の組み立てが正しいか」だけを検証する。** 実際のピクセル描画結果は検証しない（それは実機確認の役割）。モック方針の具体例:
   ```ts
   // グローバル Image をモックし、onload を同期的に発火させる
   class FakeImage {
     onload: (() => void) | null = null;
     width = 2000; height = 1000;
     set src(_v: string) { queueMicrotask(() => this.onload?.()); }
   }
   (global as any).Image = FakeImage;

   // canvas.getContext('2d') をモックし、drawImage 呼び出しを記録するだけの ctx を返す
   const drawImageCalls: any[] = [];
   const fakeCtx = { drawImage: (...args: any[]) => drawImageCalls.push(args) };
   const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx, toDataURL: (type: string) => `data:${type};base64,RESIZED` };
   jest.spyOn(document, 'createElement').mockImplementation((tag: string) =>
     tag === 'canvas' ? (fakeCanvas as any) : document.createElement(tag));
   ```
   これで「2000x1000 の画像を渡すと `drawImage` が (1568, 784) 相当の引数で呼ばれ、返ってくる `PendingImage.data` が `RESIZED` になっている」ところまで検証できる。`document.createElement` を丸ごとモックすると他の DOM 生成（React 内部含む）に影響しうるので、**`tag === 'canvas'` のときだけ差し替え、それ以外は本物にフォールバックする**実装にする（上記コード例のとおり）。テスト後は `mockRestore()` を忘れないこと。

3. **`send()` 全体の統合テストでは、`resizeImageIfNeeded` を widget インスタンス上で spy して恒等関数（引数をそのまま返す）に差し替える。** 既存の `saveUserEdit` 系テストが `send()` 自体をモックしているのと同じ発想で、「縮小ロジックの中身」と「`send()` が縮小結果をちゃんと `variables`/`attachedPreviews` に反映しているか」を分離して検証する。

4. **GIF 除外の回帰テスト**: `mimeType: 'image/gif'` の `PendingImage` を渡したとき `resizeImageIfNeeded` が入力をそのまま返す（`Image`/canvas のモックが一切呼ばれない）ことを確認するテストを 1 本入れる。

5. **実機確認**（SPEC 受入条件 6）は Jest でカバーしきれない「実際に縮小された画像が正しく表示され、AI にも正しく渡っているか」を担う。1568px 超の画像を貼り付けて送信し、devtools の Network（もしくは `console.log` の `images=` 件数ログ、L794 付近）で縮小後サイズになっていることを確認する手順を BUILD_NOTES.md に残す。

### 5.3 テスト実行

`npm test` (= `jest --config configs/jest.config.ts`, `arschat-chat` パッケージ内)。既存 77 件 + 新規追加分すべて green が受入条件 5。

## 6. まとめ (作業順序の推奨)

1. (A)(B) は実装済みなので、まず現状の挙動を実機で軽く触って壊れていないか確認する。
2. `computeResizeTarget` の純粋関数を新規ファイルとして実装 + 単体テスト。
3. `resizeImageIfNeeded`（canvas 呼び出し側）を実装 + モックテスト。
4. `send()` に縮小ステップを差し込む（§3.1 の並び順に注意: pendingImages クリアが先、縮小とユーザー吹き出し push はその後）。
5. (A)(B) の Jest テストを追加（§5.1）。
6. `npm test` で既存 77 件 + 新規分が green であることを確認。
7. 実機確認: 貼り付け一覧表示・個別削除・大きい画像の自動縮小の 3 動作。
8. BUILD_NOTES.md に追記。
