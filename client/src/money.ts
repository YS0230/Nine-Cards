// 桌面金額顯示用：依剩餘金額挑一張最接近的紙幣/硬幣圖示（純裝飾，非實際找零邏輯）
const DENOMS = [2000, 1000, 500, 200, 50, 10] as const;

export function moneyIconUrl(amount: number): string {
  const denom = DENOMS.find((d) => amount >= d) ?? DENOMS[DENOMS.length - 1];
  return `/money/${denom}.png`;
}
