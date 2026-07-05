# 九支仔 — 即時多人連線對戰

行動裝置優先的網頁卡牌對戰遊戲。採用**權威伺服器**：所有牌堆、發牌、手牌、回合驗證都在
server 運算，前端只收到「伺服器允許它看到」的個人化狀態，避免作弊。

> 目前為 **MVP**：連線 → 發牌 → 摸牌 → 打牌 → 吃牌 → 五對胡牌 已可完整遊玩。
> 進階規則（死牌先進先出、聽牌宣告、抽五隻、胡開、依顏色計分、一炮多響、流局連莊）尚未實作，
> 引擎已保留擴充點。詳見 `game rule.md`。

## 專案結構

```
shared/   前後端共用的型別、牌組定義與規則核心工具（buildDeck / isPair / isWinningSet…）
server/   Node + Express + Socket.IO 權威引擎（game/engine.ts、game/gameServer.ts）
client/   React + Vite 行動優先前端
scripts/  slice.mjs — 把 Sprite Sheet.png 切成 28 張牌面
```

## 安裝

```bash
npm install
# 若原生套件（sharp / esbuild）安裝腳本被擋，執行：
npm approve-scripts esbuild && npm approve-scripts sharp
npm run slice        # 產生 client/public/cards/*.png（28 張牌面）
```

## 開發執行

```bash
npm run dev          # 同時啟動 server(:3001) 與 client(:5173)
```

- 用電腦瀏覽器開多個分頁，或同網段手機連 `http://<你的電腦IP>:5173`。
- 一人「建立房間」拿到 4 碼房號 → 其他人「輸入房號加入」或「快速配對」。
- 房主在 2–4 人到齊後按「開始遊戲」。

## 測試

```bash
npm test             # 引擎單元測試（牌數/配對/胡牌/發牌/回合合法性/隱藏手牌）
```

## 部署備註

- Server 為記憶體狀態，適合單機起步；要水平擴充再引入 Redis。
- 前端可用 `VITE_SERVER_URL` 指定正式環境的 server 位址。
