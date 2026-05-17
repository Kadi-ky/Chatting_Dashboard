/**
 * Voucher pricing — operator brief 2026-05-14: "selling it at a price point
 * of 50-99 dollars depending on the PPV price point".
 *
 * Strategy: bump the asset's base price into the $50-$99 premium tier,
 * frame it psychologically as "50% off" (which implies a regular price of
 * $100-$198 that the fan can't verify against catalog because vouchers go
 * to silent fans who aren't browsing the catalog actively).
 *
 * Tier map (base → voucher):
 *   < $20 base (rung 1, ~$15)  → $50 voucher  ("50% off $100")
 *   $20-$50 (rung 2, ~$35)     → $69 voucher  ("50% off $138")
 *   $50-$80 (rung 3, ~$69)     → $89 voucher  ("50% off $178")
 *   $80+ (rung 4, ~$99)        → $99 voucher  ("50% off $198")
 *
 * Floor $50, ceil $99. Cheap assets get marked UP because voucher is the
 * frame, not the catalog reality.
 */

export function calculateVoucherPriceCents(basePriceCents: number): number {
  const baseDollars = basePriceCents / 100;
  if (baseDollars < 20) return 5000; // $50
  if (baseDollars < 50) return 6900; // $69
  if (baseDollars < 80) return 8900; // $89
  return 9900; // $99
}

/**
 * The "implied regular price" we tell the fan in caption framing.
 * Always 2× voucher (so "50% off" math checks out if fan does it).
 */
export function impliedRegularPriceCents(voucherPriceCents: number): number {
  return voucherPriceCents * 2;
}
