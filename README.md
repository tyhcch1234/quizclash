# QuizClash · 即時問答比賽

像 Kahoot 的課堂搶答遊戲：老師建立四選一題目 → 投影房間碼與 QR code → 學生用手機加入 → 即時計分、即時排行榜，完場選出冠軍。

純靜態網頁（HTML + CSS + 原生 JS），可直接放在 GitHub Pages，**不需要伺服器、不需要資料庫、不需要帳號**。

**線上版：https://tyhcch1234.github.io/quizclash/**

## 玩法

1. 老師開 `host.html`，輸入題目（或匯入 CSV），按「開始遊戲」。
2. 大螢幕出現 QR code 與 6 位房間碼。
3. 學生開 `play.html`（掃 QR 會自動填碼），輸入名字加入。
4. 老師按「開始第一題」，倒數同步開始，學生手機上按 A/B/C/D（或鍵盤 1–4）。
5. 時間到自動揭曉：正確答案、各選項人數分佈、目前領先名單。
6. 全部題目完成後顯示三甲與完整排行榜，可匯出成績 CSV。

## 功能

| 功能 | 說明 |
| --- | --- |
| 四選一題目 | 每題 4 個選項，點 A/B/C/D 圓標設定正確答案 |
| 每題時限 | 5–120 秒，逐題設定，倒數同步到所有手機 |
| 速度計分 | 答對 600 分 + 最多 400 分速度分 + 連對加成（最高 200） |
| 雙榜排名 | 可切換「最高分」或「答對最多」，排行榜與冠軍即時跟隨 |
| 圖片題 | 上傳圖片自動壓縮（長邊 900px、JPEG 0.72），適合數學圖形／圖表 |
| CSV 匯入／匯出 | 整批題目匯入、匯出備份、成績匯出 |
| 題庫 | 存在瀏覽器 localStorage，首頁可再開啟、編輯、刪除 |
| 房間碼 + QR | 6 位碼（去掉易混淆的 I/O/0/1），QR 內嵌 SVG 不需外部服務 |
| 防重複作答 | 同一題只計第一次，重複送出不會加分 |
| 防提前看答案 | 未揭曉前，廣播資料不包含正確答案與他人選擇 |
| 斷線重連 | MQTT 自動重連；手機重新載入會用同一身分重新加入 |
| 主持畫面復原 | 不小心重新載入 `host.html#房間碼` 會還原房間與名單 |

## CSV 格式

第一列可為表頭（會被自動略過）。欄位順序：

```
題目, 選項A, 選項B, 選項C, 選項D, 正確答案, 時限秒, 圖片URL
```

- **正確答案**：可填 `A`–`D`、`1`–`4`，或直接填該選項的完整文字。
- **時限秒**：留空則用 20 秒；超出 5–120 會自動夾回範圍。
- **圖片URL**：可留空，支援 `https://` 連結或 `data:image/...`。
- 選項少於 2 個的列會略過並提示。

範例：

```csv
題目,選項A,選項B,選項C,選項D,正確答案,時限秒,圖片URL
2x+4 的因式分解是？,2(x+2),2(x+4),x(2+4),2x(x+2),A,20,
香港特別行政區成立於哪一年？,1995,1997,1999,2000,B,15,
```

## 技術架構

```
index.html      首頁：建立題目 / 加入房間 / 我的題庫
host.html       主持人：題目編輯器 + 大螢幕遊戲控制台（全場唯一狀態寫入者）
play.html       玩家手機頁：加入、作答、看成績
assets/core.js  純邏輯（計分、排名、CSV、狀態）— 可在 Node 跑單元測試
assets/net.js   MQTT 連線、QR 繪製、圖片壓縮、UI 小工具
assets/host.js  編輯器與主持流程
assets/play.js  玩家流程
assets/vendor/  mqtt.js 5.10.1、qrcode-generator 1.4.4（本地內嵌，不依賴 CDN）
tests/          core 單元測試（Node）
```

**同步方式**：MQTT over WebSocket，公共 broker `wss://broker.emqx.io:8084/mqtt`。

- `quizclash/v1/<CODE>/state`（主持 → 全場，retained）：階段、題號、倒數結束時間、玩家分數、揭曉結果。
- `quizclash/v1/<CODE>/q`（主持 → 全場，retained）：目前題目文字、選項、圖片（不含答案）。
- `quizclash/v1/<CODE>/ev`（玩家 → 主持）：加入、作答。
- 用 **retained message**，所以中途加入或重新整理的人都會立即收到目前狀態。
- 主持人是唯一狀態寫入者；手機端只讀狀態、只送事件，不能改分數。

### 計分公式

```
答對：600（基本） + 400 × (剩餘時間 ÷ 時限) + 50 × min(連對次數, 4)
答錯：0，連對歸零
```

單題最高 1200 分。同一題重複送出只計第一次。

## 本機測試

```bash
node tests/core.test.js
```

涵蓋：房間碼格式、題目正規化與驗證、計分與連對、重複／逾時作答攔截、揭曉前不洩漏答案、雙榜排名、CSV 解析與來回轉換、成績匯出。

## 部署到 GitHub Pages

```bash
git init
git add .
git commit -m "QuizClash: Kahoot-style live quiz"
git branch -M main
git remote add origin https://github.com/<帳號>/quizclash.git
git push -u origin main
```

repo → Settings → Pages → Source: `Deploy from a branch` → `main` / `root` → Save。
約一分鐘後：`https://<帳號>.github.io/quizclash/`。

> 程式全部使用相對路徑，放在 `/<repo>/` 子路徑下可直接運作。

## 已知限制

- 資料經過**公開** MQTT broker，主題只用 6 位隨機碼區分。適合課堂即時使用，**不要傳送敏感或個人資料**（建議只用名字或暱稱）。
- 沒有後端資料庫：主持分頁關閉後資料不再更新；需要保存請即時匯出成績 CSV。
- 公共 broker 偶爾不穩，頁面會顯示「重新連線中」並自動重試。課堂前建議先開一次確認連線正常。
- 6 位房間碼有極低機率撞號，重新開始即會換新碼。
- 題目圖片上限約 650KB（base64），上傳時會自動壓縮；過大請先手動縮圖。

## 授權

站內程式碼可自由使用。第三方：mqtt.js（MIT）、qrcode-generator（MIT，Kazuhiko Arase）。
