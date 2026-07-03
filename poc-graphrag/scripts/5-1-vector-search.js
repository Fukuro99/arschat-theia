// PoC-5-1: better-sqlite3 + sqlite-vec で vec0 仮想テーブルを作り、
// 384次元のダミー埋め込みベクター(決定的な擬似乱数, 50件)を挿入して
// KNN類似検索 (MATCH句) が動くことを確認する。
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

const DIM = 384;
const N = 50;
const DB_PATH = path.join(__dirname, "..", "data", "5-1-vectors.db");

// 決定的な擬似乱数生成器 (mulberry32) — 実行毎に同じベクターが生成される
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeVector(rand, dim) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = rand() * 2 - 1; // [-1, 1)
  }
  return v;
}

function main() {
  console.log("=== PoC-5-1: sqlite-vec ベクター類似検索 ===");
  console.log(`node: ${process.version} / ABI: ${process.versions.modules}`);

  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);

  // sqlite-vec 拡張のロード
  sqliteVec.load(db);
  const [{ vec_version: vecVersion }] = db
    .prepare("select vec_version() as vec_version")
    .all();
  console.log(`sqlite-vec version: ${vecVersion}`);

  // vec0 仮想テーブル作成 (384次元 float32)
  db.exec(`
    CREATE VIRTUAL TABLE vec_items USING vec0(
      id INTEGER PRIMARY KEY,
      embedding float[${DIM}]
    );
  `);

  // メタ情報テーブル(通常テーブル): vec0 は任意列を持てないため id で紐付ける
  db.exec(`
    CREATE TABLE items_meta (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL
    );
  `);

  const insertVec = db.prepare(
    "INSERT INTO vec_items (id, embedding) VALUES (?, ?)"
  );
  const insertMeta = db.prepare(
    "INSERT INTO items_meta (id, label) VALUES (?, ?)"
  );

  const rand = mulberry32(42); // 固定シード
  const vectors = [];
  const insertAll = db.transaction(() => {
    for (let i = 1; i <= N; i++) {
      const v = makeVector(rand, DIM);
      vectors.push(v);
      insertVec.run(BigInt(i), Buffer.from(v.buffer));
      insertMeta.run(i, `item-${i}`);
    }
  });
  insertAll();
  console.log(`挿入件数: ${N} 件 (${DIM}次元 float32, seed=42 の決定的擬似乱数)`);

  // クエリベクター: item-1 のベクターに小さいノイズを加えたもの
  // -> 類似検索で id=1 が最上位近傍に来ることを期待
  const noiseRand = mulberry32(999);
  const query = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    query[i] = vectors[0][i] + (noiseRand() * 2 - 1) * 0.01;
  }

  const knn = db
    .prepare(
      `
      SELECT v.id, v.distance, m.label
      FROM vec_items v
      JOIN items_meta m ON m.id = v.id
      WHERE v.embedding MATCH ?
        AND k = 5
      ORDER BY v.distance
    `
    )
    .all(Buffer.from(query.buffer));

  console.log("\nKNN検索結果 (query = item-1 + 微小ノイズ, k=5):");
  for (const row of knn) {
    console.log(
      `  id=${row.id}\tlabel=${row.label}\tdistance=${row.distance.toFixed(6)}`
    );
  }

  const top = knn[0];
  const pass = top && top.id === 1;
  console.log(
    `\n判定: 最近傍が item-1 (自分自身+ノイズ) である -> ${pass ? "PASS" : "FAIL"}`
  );

  // 生ベクター同士のブルートフォースコサイン距離とも突き合わせて健全性チェック
  function cosine(a, b) {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  const bruteForce = vectors
    .map((v, idx) => ({ id: idx + 1, dist: cosine(query, v) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);
  console.log("\n(健全性チェック) JS側ブルートフォース コサイン距離 top5:");
  for (const row of bruteForce) {
    console.log(`  id=${row.id}\tdist=${row.dist.toFixed(6)}`);
  }
  const bruteTopMatches = bruteForce[0].id === top?.id;
  console.log(
    `突合せ: sqlite-vec の1位とブルートフォースの1位が一致 -> ${bruteTopMatches ? "PASS" : "FAIL"}`
  );

  db.close();
  console.log(`\nDBファイル: ${DB_PATH}`);
  process.exit(pass && bruteTopMatches ? 0 : 1);
}

main();
