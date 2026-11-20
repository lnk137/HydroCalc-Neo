const test = require("node:test");
const assert = require("node:assert/strict");
const { wettingProfile } = require("../HC-FrontEnd/src/wetting.ts");

// 非整数边界必须读取整行累计和部分行，避免显示曲线的舍入影响实时结果。
test("interactive wetting metrics use raw counts and fractional rows", () => {
  const measure = wettingProfile([10, 5, 2, 1], 10, 80);
  const values = measure(50);
  assert.equal(values.a_root, 160);
  assert.equal(values.a_tot, 180);
  assert.equal(values.root_layer_count, 2.5);
  assert.equal(values.es_percent, 64);
  assert.ok(Math.abs(values.rdpr_percent - 100 / 9) < 1e-10);
  assert.equal(measure(80).rdpr_percent, 0);
  assert.equal(measure(0).rdpr_percent, 100);
});

// 零分母和超出图像的深度保持明确的不可用状态。
test("interactive preview preserves zero and unavailable semantics", () => {
  const empty = wettingProfile([0, 0], 10, 50);
  assert.equal(empty(40).rdpr_percent, null);
  assert.equal(empty(40).es_percent, 0);
  const measure = wettingProfile([10, 10], 10, 50);
  assert.equal(measure(60).rdpr_percent, null);
  assert.equal(measure(60).a_root, null);
  assert.equal(measure(60).a_tot, 200);
});
