const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { defaults, validateSettings } = require("../electron/settings.cjs");
const { Repository } = require("../electron/repository.cjs");

const executable =
  process.platform === "win32" ? "hydrocalc-worker.exe" : "hydrocalc-worker";
const worker = path.resolve(__dirname, "..", "dist", "worker", executable);

function analyze(width, height, pixel, overrides = {}) {
  // PPM 是无损、无外部依赖的真实图像输入，仍通过完整 OpenCV 解码和工作进程。
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hydrocalc 中文 "));
  const input = path.join(directory, "土壤 image.ppm");
  const body = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pixel(x, y);
      for (let channel = 0; channel < 3; channel++)
        body[(y * width + x) * 3 + channel] = color[channel];
    }
  }
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  fs.writeFileSync(input, Buffer.concat([header, body]));
  const settings = validateSettings({
    ...defaults,
    method: "binary",
    resolution_width: width,
    resolution_height: height,
    enable_clustering: false,
    ...overrides,
  });
  const command = {
    input,
    output: directory,
    settings,
  };
  const result = spawnSync(worker, [], {
    input: JSON.stringify(command) + "\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const messages = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const data = messages.find((message) => message.event === "result").data;
  return {
    directory,
    data,
    cleanup: () =>
      fs.rmSync(directory, {
        recursive: true,
        force: true,
      }),
  };
}

for (const resolution of [100, 500, 1000]) {
  test(`physical calibration is resolution invariant at ${resolution}px`, () => {
    const run = analyze(
      resolution,
      resolution,
      (_x, y) => (y < resolution / 2 ? [0, 0, 0] : [255, 255, 255]),
      {
        soil_height_cm: 40,
      },
    );
    try {
      assert.equal(run.data.metrics.stained_area_cm2, 1000);
      assert.equal(run.data.metrics.matrix_depth_cm, 20);
      assert.equal(run.data.metrics.maximum_depth_cm, 20);
      assert.equal(run.data.metrics.priority_percentage, 0);
      assert.equal(run.data.metrics.length_index, 100);
      assert.equal(run.data.profile.length, resolution);
    } finally {
      run.cleanup();
    }
  });
}

for (const stained of [false, true]) {
  test(`uniform ${stained ? "black" : "white"} images have finite metrics`, () => {
    const run = analyze(100, 100, () =>
      stained ? [0, 0, 0] : [255, 255, 255],
    );
    try {
      assert.equal(run.data.metrics.stained_area_cm2, stained ? 2500 : 0);
      assert.equal(run.data.metrics.matrix_depth_cm, stained ? 50 : 0);
      assert.equal(run.data.metrics.maximum_depth_cm, stained ? 50 : 0);
      assert.equal(run.data.metrics.priority_percentage, 0);
      assert.equal(run.data.metrics.a_root, stained ? 8000 : 0);
      assert.equal(run.data.metrics.a_tot, stained ? 10000 : 0);
      assert.equal(run.data.metrics.es_percent, stained ? 100 : 0);
      assert.equal(run.data.metrics.ea_percent, stained ? 80 : null);
      assert.equal(run.data.root_zone.status, stained ? "ok" : "zero_staining");
    } finally {
      run.cleanup();
    }
  });
}

test("priority flow uses actual pixels below matrix boundary", () => {
  const run = analyze(100, 100, (x, y) =>
    x < (y < 50 ? 90 : 20) ? [0, 0, 0] : [255, 255, 255],
  );
  try {
    assert.equal(run.data.metrics.stained_area_cm2, 1375);
    assert.equal(run.data.metrics.priority_area_ratio, 10);
    assert.equal(run.data.metrics.priority_percentage, 18.1818);
  } finally {
    run.cleanup();
  }
});

test("HSV extraction and both clustering variants share physical calibration", () => {
  const run = analyze(
    100,
    100,
    (x, y) => (y < 50 ? [40 + Math.floor(x / 3), 130, 90] : [255, 255, 255]),
    {
      method: "hsv",
      denoise_enabled: false,
      enable_clustering: true,
      soil_height_cm: 40,
    },
  );
  try {
    assert.equal(run.data.metrics.stained_ratio, 50);
    for (const key of ["clusters", "clusters_blurred"]) {
      assert.ok(fs.existsSync(path.join(run.directory, key + ".png")));
      const ratio = run.data.colors[key].reduce(
        (sum, color) => sum + color.ratio,
        0,
      );
      assert.ok(Math.abs(ratio - 100) < 0.001);
      const area = run.data.colors[key].reduce(
        (sum, color) => sum + color.area_cm2,
        0,
      );
      assert.ok(Math.abs(area - 2000) < 0.001);
    }
  } finally {
    run.cleanup();
  }
});

test("invalid settings never reach the native worker", () => {
  const invalid = [
    { resolution_width: 0 },
    { soil_width_cm: NaN },
    { soil_height_cm: true },
    { planned_wetting_depth_cm: 0 },
    { planned_wetting_depth_cm: -1 },
    { planned_wetting_depth_cm: NaN },
    { planned_wetting_depth_cm: "60" },
    { lower_hsv: [180, 0, 0] },
    { lower_hsv: [100, 0, 0], upper_hsv: [50, 255, 255] },
    { clusters: 2.5 },
    { reduce_motion: "false" },
    { start_depth_cm: 50 },
    { method: "model" },
    { denoise_method: "gaussian" },
    { blur_kernel: 4 },
    { median_kernel: 4 },
    { bilateral_diameter: 2 },
    { bilateral_sigma_color: NaN },
    { nlm_h: -1 },
    { nlm_h_color: Infinity },
    { nlm_template_window: 4 },
    { nlm_search_window: 8 },
    { nlm_template_window: 9, nlm_search_window: 7 },
    { denoise_enabled: "true" },
    { unknown: 1 },
  ];
  for (const settings of invalid)
    assert.throws(() => validateSettings(settings));
});

test("SQLite persists history and marks interrupted work after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hydrocalc-db-"));
  let repository = new Repository(directory);
  const id = "a".repeat(32);
  repository.put({
    id,
    created_at: new Date().toISOString(),
    name: "中文图片.png",
    status: "running",
  });
  repository.close();
  repository = new Repository(directory);
  assert.equal(repository.get(id).status, "failed");
  assert.equal(repository.get(id).name, "中文图片.png");
  repository.delete(id);
  assert.equal(repository.history().length, 0);
  repository.close();
  fs.rmSync(directory, {
    recursive: true,
    force: true,
  });
});

// 强对比单行染色区用于捕捉滤波向相邻白色行扩散的回归。
test("bilateral denoising preserves a one-pixel stained channel", () => {
  const run = analyze(
    100,
    100,
    (_x, y) => (y === 50 ? [0, 0, 255] : [255, 255, 255]),
    {
      method: "hsv",
      bilateral_diameter: 5,
    },
  );
  try {
    assert.equal(run.data.metrics.stained_ratio, 1);
    assert.equal(run.data.metrics.stained_area_cm2, 25);
    assert.equal(run.data.metrics.maximum_depth_cm, 25.5);
    assert.deepEqual(run.data.preprocessing, {
      method: "bilateral",
      diameter: 5,
      sigma_color: 25,
      sigma_space: 5,
    });
  } finally {
    run.cleanup();
  }
});

// 二值输入中的孤立染色像素直接参与统计，避免参考掩膜被预处理改写。
test("binary inputs retain isolated stained pixels with denoising enabled", () => {
  const run = analyze(100, 100, (x, y) =>
    x === 50 && y === 50 ? [0, 0, 0] : [255, 255, 255],
  );
  try {
    assert.equal(run.data.metrics.stained_area_cm2, 0.25);
    assert.equal(run.data.preprocessing.method, "none");
    assert.deepEqual(run.data.preprocessing, {
      method: "none",
    });
  } finally {
    run.cleanup();
  }
});

// 旧设置的开关与邻域值迁移到新算法，关闭时仍通过实际 C++ 流程核验。
test("legacy settings retain their neighborhood and disabled denoising stays off", () => {
  const legacy = validateSettings({
    blur_kernel: 3,
  });
  assert.equal(legacy.denoise_method, "bilateral");
  assert.equal(legacy.bilateral_diameter, 3);
  assert.equal(legacy.denoise_enabled, true);
  assert.equal(Object.hasOwn(legacy, "blur_kernel"), false);
  const disabled = validateSettings({
    blur_kernel: 0,
  });
  assert.equal(disabled.denoise_enabled, false);
  const run = analyze(100, 100, () => [0, 0, 255], {
    method: "hsv",
    denoise_enabled: false,
  });
  try {
    assert.equal(run.data.metrics.stained_ratio, 100);
    assert.equal(run.data.preprocessing.method, "none");
    assert.deepEqual(run.data.preprocessing, {
      method: "none",
    });
  } finally {
    run.cleanup();
  }
});

// 对三种算法分别核对参数传递，固定单色图用于排除分割阈值的干扰。
for (const method of ["bilateral", "median", "nlm"]) {
  test(`${method} uses its selected parameters in the native worker`, () => {
    const run = analyze(100, 100, () => [0, 0, 255], {
      method: "hsv",
      denoise_method: method,
      bilateral_diameter: 7,
      bilateral_sigma_color: 30,
      bilateral_sigma_space: 6,
      median_kernel: 5,
      nlm_h: 3,
      nlm_h_color: 4,
      nlm_template_window: 3,
      nlm_search_window: 7,
    });
    try {
      assert.equal(run.data.metrics.stained_ratio, 100);
      assert.equal(run.data.preprocessing.method, method);
      if (method === "bilateral") {
        assert.equal(run.data.preprocessing.diameter, 7);
        assert.equal(run.data.preprocessing.sigma_color, 30);
        assert.equal(run.data.preprocessing.sigma_space, 6);
      }
      if (method === "median") {
        assert.equal(run.data.preprocessing.kernel, 5);
      }
      if (method === "nlm") {
        assert.equal(run.data.preprocessing.h, 3);
        assert.equal(run.data.preprocessing.h_color, 4);
        assert.equal(run.data.preprocessing.template_window, 3);
        assert.equal(run.data.preprocessing.search_window, 7);
      }
    } finally {
      run.cleanup();
    }
  });
}

// 中值滤波会移除孤立单行，而关闭开关后同一输入保持原始染色计数。
test("median selection changes segmentation and the master switch bypasses it", () => {
  const pixel = (_x, y) => (y === 50 ? [0, 0, 255] : [255, 255, 255]);
  const filtered = analyze(100, 100, pixel, {
    method: "hsv",
    denoise_method: "median",
  });
  const disabled = analyze(100, 100, pixel, {
    method: "hsv",
    denoise_method: "median",
    denoise_enabled: false,
  });
  try {
    assert.equal(filtered.data.metrics.stained_ratio, 0);
    assert.equal(disabled.data.metrics.stained_ratio, 1);
    assert.equal(disabled.data.preprocessing.method, "none");
  } finally {
    filtered.cleanup();
    disabled.cleanup();
  }
});

// 合成掩膜的黑格计数捕捉百分数 DC 与 0–1 DC 混用，以及第 400 行边界错位。
test("root-zone sums reproduce known pixel counts in a synthetic mask", () => {
  const run = analyze(500, 500, (x, y) => {
    const inRoot = y < 400 && y * 500 + x < 33050;
    const belowRoot = y === 400 && x < 100;
    return inRoot || belowRoot ? [0, 0, 0] : [255, 255, 255];
  });
  try {
    const values = run.data.metrics;
    assert.ok(Math.abs(values.a_root - 6610) < 1e-9);
    assert.ok(Math.abs(values.a_tot - 6630) < 1e-9);
    assert.equal(values.root_layer_count, 400);
    assert.equal(values.total_layer_count, 500);
    assert.ok(Math.abs(values.rdpr_percent - 10000 / 33150) < 1e-9);
    assert.ok(Math.abs(values.ea_percent + values.rdpr_percent - 100) < 1e-9);
    assert.ok(Math.abs(values.es_percent - 16.525) < 1e-9);
    assert.equal(run.data.root_zone.dc_scale, "percent");
    assert.equal(run.data.root_zone.status, "ok");
  } finally {
    run.cleanup();
  }
});

// 60 cm 剖面在 64 行中产生非整数湿润层边界，所有行均参与全剖面总量。
test("fractional wetting rows use physical overlap and full-profile totals", () => {
  const run = analyze(
    64,
    64,
    (_x, y) => ([42, 53, 60].includes(y) ? [0, 0, 0] : [255, 255, 255]),
    {
      soil_height_cm: 60,
    },
  );
  try {
    const values = run.data.metrics;
    assert.ok(Math.abs(values.a_root - 200 / 3) < 1e-9);
    assert.equal(values.a_tot, 300);
    assert.ok(Math.abs(values.rdpr_percent - (1 - 2 / 9) * 100) < 1e-9);
    assert.ok(Math.abs(values.es_percent - 1.5625) < 1e-9);
    // 逐行导出保留原始计数和贡献，独立累加后应复现未舍入中间量。
    const content = fs.readFileSync(
      path.join(run.directory, "profile.csv"),
      "utf8",
    );
    const rows = content.trim().split("\n").slice(1);
    const sums = rows.reduce(
      (totals, row) => {
        const cells = row.split(",").map(Number);
        totals.root += cells[6];
        totals.total += cells[7];
        return totals;
      },
      {
        root: 0,
        total: 0,
      },
    );
    assert.ok(Math.abs(sums.root - values.a_root) < 1e-9);
    assert.ok(Math.abs(sums.total - values.a_tot) < 1e-9);
  } finally {
    run.cleanup();
  }
});

// 分辨率改变有效层数，但同一完整染色剖面的三项比例应保持一致。
for (const resolution of [100, 500, 1000]) {
  test(`root-zone rates remain calibrated at ${resolution} rows`, () => {
    const run = analyze(resolution, resolution, () => [0, 0, 0]);
    try {
      const values = run.data.metrics;
      assert.equal(values.a_root, resolution * 80);
      assert.equal(values.a_tot, resolution * 100);
      assert.equal(values.root_layer_count, resolution * 0.8);
      assert.ok(Math.abs(values.rdpr_percent - 20) < 1e-9);
      assert.equal(values.ea_percent, 80);
      assert.equal(values.es_percent, 100);
    } finally {
      run.cleanup();
    }
  });
}

// 剖面不足计划湿润层时根区指标置空，全剖面统计仍保留实际图像总量。
for (const depth of [39, 40, 49.9]) {
  test(`root-zone availability is explicit for a ${depth} cm profile`, () => {
    const run = analyze(100, 100, () => [0, 0, 0], {
      soil_height_cm: depth,
    });
    try {
      const values = run.data.metrics;
      assert.equal(values.a_tot, 10000);
      assert.equal(values.total_layer_count, 100);
      if (depth < 40) {
        assert.equal(values.rdpr_percent, null);
        assert.equal(values.ea_percent, null);
      } else {
        assert.ok(Math.abs(values.ea_percent - (40 / depth) * 100) < 1e-9);
      }
      assert.equal(values.es_percent, depth >= 40 ? 100 : null);
      assert.equal(
        run.data.root_zone.status,
        depth < 40 ? "insufficient_depth" : "ok",
      );
    } finally {
      run.cleanup();
    }
  });
}

// 空白全剖面的零分母不能转换成零损失率。
test("zero staining in the full profile leaves RDPR and Ea undefined", () => {
  const run = analyze(100, 100, () => [255, 255, 255], {
    soil_height_cm: 60,
  });
  try {
    const values = run.data.metrics;
    assert.equal(values.a_root, 0);
    assert.equal(values.a_tot, 0);
    assert.equal(values.es_percent, 0);
    assert.equal(values.rdpr_percent, null);
    assert.equal(values.ea_percent, null);
    assert.equal(run.data.root_zone.status, "zero_staining");
  } finally {
    run.cleanup();
  }
});

// 旧设置补入 40 cm 默认值，用户输入的小数深度作为实际参数保存。
test("planned wetting depth migrates old settings and accepts decimals", () => {
  const legacy = validateSettings({
    soil_height_cm: 80,
  });
  assert.equal(legacy.planned_wetting_depth_cm, 40);
  const custom = validateSettings({
    soil_height_cm: 80,
    planned_wetting_depth_cm: 60.5,
  });
  assert.equal(custom.planned_wetting_depth_cm, 60.5);
});

// 三种分布覆盖湿润层内、边界以下和全剖面，60 cm 以下应全部计入损失。
for (const distribution of ["retained", "leakage", "full"]) {
  test(`custom 60 cm wetting depth measures ${distribution} staining in an 80 cm profile`, () => {
    const run = analyze(
      100,
      100,
      (_x, y) => {
        const retained = distribution === "retained" && y < 75;
        const leakage = distribution === "leakage" && y >= 75;
        const stained = distribution === "full" || retained || leakage;
        return stained ? [0, 0, 0] : [255, 255, 255];
      },
      {
        soil_height_cm: 80,
        planned_wetting_depth_cm: 60,
      },
    );
    try {
      const values = run.data.metrics;
      const expected = {
        retained: 0,
        leakage: 100,
        full: 25,
      };
      assert.equal(values.rdpr_percent, expected[distribution]);
      assert.equal(values.ea_percent, 100 - expected[distribution]);
      assert.equal(values.root_layer_count, 75);
      assert.equal(values.total_layer_count, 100);
      assert.equal(run.data.root_zone.root_depth_cm, 60);
      assert.equal(run.data.root_zone.total_depth_cm, 80);
      assert.equal(run.data.root_zone.total_scope, "full_profile");
    } finally {
      run.cleanup();
    }
  });
}

// 小数湿润层对应非整数层数，边界恰好等于图底时全部染色都留在湿润层内。
for (const plannedDepth of [60.5, 80]) {
  test(`planned ${plannedDepth} cm depth uses weighted rows and the bottom boundary`, () => {
    const run = analyze(100, 100, () => [0, 0, 0], {
      soil_height_cm: 80,
      planned_wetting_depth_cm: plannedDepth,
    });
    try {
      const values = run.data.metrics;
      const expectedEfficiency = (plannedDepth / 80) * 100;
      assert.ok(Math.abs(values.ea_percent - expectedEfficiency) < 1e-9);
      assert.equal(values.es_percent, 100);
      assert.ok(Math.abs(values.root_layer_count - plannedDepth / 0.8) < 1e-9);
    } finally {
      run.cleanup();
    }
  });
}

// 对染色可视化再次执行红色 HSV 分割，确保边界以下染色实际输出为红色。
test("wetting image marks deep staining red and preserves the binary matrix", () => {
  const run = analyze(100, 100, () => [0, 0, 0], {
    soil_height_cm: 80,
    planned_wetting_depth_cm: 60,
  });
  try {
    const output = path.join(run.directory, "red-check");
    fs.mkdirSync(output);
    const settings = validateSettings({
      method: "hsv",
      denoise_enabled: false,
      enable_clustering: false,
      resolution_width: 100,
      resolution_height: 100,
      soil_height_cm: 80,
      planned_wetting_depth_cm: 60,
      lower_hsv: [0, 80, 80],
      upper_hsv: [12, 255, 255],
    });
    const command = {
      input: path.join(run.directory, "wetting.png"),
      output,
      settings,
    };
    const execution = spawnSync(worker, [], {
      input: JSON.stringify(command) + "\n",
      encoding: "utf8",
    });
    assert.equal(execution.status, 0, execution.stdout);
    const messages = execution.stdout.trim().split("\n").map(JSON.parse);
    const result = messages.find((message) => message.event === "result").data;
    assert.equal(result.metrics.stained_ratio, 25);
    const matrix = fs.readFileSync(
      path.join(run.directory, "matrix.csv"),
      "utf8",
    );
    const remaining = matrix.replace(/[0,\n]/g, "");
    assert.equal(remaining, "");
  } finally {
    run.cleanup();
  }
});

module.exports = {
  analyze,
};
