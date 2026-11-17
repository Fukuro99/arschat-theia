---
scope: core
---
# IME を扱う入力欄は uncontrolled で作る

日本語などの変換入力 (IME) を受け付ける入力欄を React で作るときは、controlled 方式 (`value` プロパティで値を固定する作り方) を使わず、**uncontrolled 方式 (`defaultValue` + ref、DOM が値を持つ作り方) + プログラム変更時は DOM へ直接書き込む setter** で作る。

## 経緯 (2026-07-18, ms-8 / ms-10 で確定)

チャット入力欄で controlled 方式を採用していたところ、IME まわりで二段階の障害が起きた:

1. **二重入力 (e-48)**: 変換中に再描画が走ると、React が入力欄へ値を書き戻して IME の変換セッションが強制確定され、文字が二重に入力される。
2. **入力不能 (恒久修正時に発覚)**: 対策として「変換中は再描画を抑制する」ゲートを入れたら、今度は React の controlled 復元機構 (onChange の後に再描画が無いと DOM の値を直前の描画値へ強制的に巻き戻す仕様) と衝突し、変換文字が 1 打鍵ごとに消えて日本語が全く入力できなくなった。

つまり controlled 方式は IME に対して「再描画する = 二重入力 / 抑制する = 入力不能」の**両詰み**であり、設定で回避できる問題ではない。

## ルール

- IME 露出の入力欄 (textarea / text input) は `defaultValue` + `React.createRef` で作る
- プログラム側から値を変える箇所 (クリア・下書き復元・サジェスト確定・設定同期など) は、フィールドと `ref.current.value` の**両方**へ書く setter を必ず経由する (arschat-chat-widget.tsx の `setInputValue` / `setEditDraft` / `setCustomEndpointDraft` が実例)
- IME 確定 Enter の誤送信ガード (`isComposing || keyCode === 229 || composing` の三重判定) と、変換中の再描画抑制ゲートは uncontrolled 化後も維持する (前者は誤送信防止、後者は変換中の無関係な DOM 更新を減らす防波堤)
- 新しい入力 UI (例: ms-13 のインタラクティブ UI) を作るときは、実装レビューでこの原則への準拠を確認する

## 検証方法

jsdom は IME を再現できないため、Jest では「composition ハンドラの直呼び + 再描画が DOM 値を上書きしないことの検証」までとし、**実機での日本語入力確認を必ず受入条件に含める** (e-48 では実機確認を挟まずに done にした結果、入力不能が後から発覚した)。
