// 以原始行计数建立前缀和，拖动时只需读取整行累计和一条边界行。
export function wettingProfile(
  counts: number[],
  width: number,
  heightCm: number,
) {
  const prefix = [0];
  for (const count of counts) {
    prefix.push(prefix[prefix.length - 1]! + count);
  }
  const total = prefix[prefix.length - 1]!;
  return (depth: number) => {
    // 零深度用于损失曲线的端点，交互输入的最小值为 0.01 cm。
    const layers = Math.max(
      0,
      Math.min(counts.length, (depth / heightCm) * counts.length),
    );
    const whole = Math.floor(layers);
    const remainder = layers - whole;
    const partial = counts[whole] ?? 0;
    const retained = prefix[whole]! + partial * remainder;
    const aRoot = (retained / width) * 100;
    const available = depth <= heightCm;
    const ea = total > 0 && available ? (retained / total) * 100 : null;
    return {
      a_root: available ? aRoot : null,
      a_tot: (total / width) * 100,
      root_layer_count: available ? layers : null,
      rdpr_percent: ea === null ? null : 100 - ea,
      ea_percent: ea,
      es_percent: available && layers > 0 ? aRoot / layers : null,
    };
  };
}
