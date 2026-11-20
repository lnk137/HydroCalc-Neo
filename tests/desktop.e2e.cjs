const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { _electron } = require("playwright");
const { defaults } = require("../electron/settings.cjs");
const { unzipSync } = require("fflate");
const { verifyCardWorkspace } = require("./card-workspace.e2e.cjs");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hydrocalc-desktop-"));
const outputDir =
  process.env.HYDROCALC_CHECK_OUTPUT || path.join(dataDir, "screenshots");
fs.mkdirSync(outputDir, {
  recursive: true,
});

function fixture(filename, binary) {
  // 测试固定图由真实 C++ 解码为 PNG；可选的实验图路径只通过环境传入，不提交用户图片。
  const directory = path.join(dataDir, filename);
  fs.mkdirSync(directory);
  const input = path.join(directory, "input.ppm");
  const pixels = Buffer.alloc(100 * 100 * 3);
  for (let row = 0; row < 100; row++) {
    for (let column = 0; column < 100; column++) {
      const color =
        row < 50 ? (binary ? [0, 0, 0] : [40, 130, 90]) : [255, 255, 255];
      for (let channel = 0; channel < 3; channel++)
        pixels[(row * 100 + column) * 3 + channel] = color[channel];
    }
  }
  fs.writeFileSync(
    input,
    Buffer.concat([Buffer.from("P6\n100 100\n255\n"), pixels]),
  );
  const worker = path.join(
    root,
    "dist",
    "worker",
    process.platform === "win32" ? "hydrocalc-worker.exe" : "hydrocalc-worker",
  );
  const command = {
    input,
    output: directory,
    settings: defaults,
  };
  const result = spawnSync(worker, [], {
    input: JSON.stringify(command) + "\n",
  });
  assert.equal(result.status, 0, result.stdout.toString());
  return path.join(directory, "original.png");
}

async function launch() {
  // 真实启动 Electron、沙盒渲染器、Node 服务和独立 C++ 进程。
  return _electron.launch({
    executablePath: process.env.HYDROCALC_EXECUTABLE || require("electron"),
    args: process.env.HYDROCALC_EXECUTABLE ? [] : [root],
    env: {
      ...process.env,
      HYDROCALC_DATA_DIR: dataDir,
    },
  });
}

async function run() {
  const colorImage =
    process.env.HYDROCALC_TEST_COLOR || fixture("color", false);
  const binaryImage =
    process.env.HYDROCALC_TEST_BINARY || fixture("binary", true);
  const invalid = path.join(dataDir, "invalid.png");
  fs.writeFileSync(invalid, "invalid image");
  let application = await launch();
  let page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page
      .getByRole("heading", { name: "图像分析", exact: true })
      .waitFor();
    assert.equal(await page.locator(".eyebrow").count(), 0);
    const background = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bg")
        .trim(),
    );
    assert.equal(background, "#f4f4f5");
    console.log("Desktop startup and neutral background passed");
    // 原生窗口尺寸回归：不使用页面视口模拟，工具栏与指标必须留在真实可见宽度内。
    const nativeWindow = await application.browserWindow(page);
    for (const width of [900, 1000, 1280]) {
      await nativeWindow.evaluate(
        (window, size) => window.setSize(size, 800),
        width,
      );
      await page.waitForTimeout(150);
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        header: document.querySelector(".page-header").getBoundingClientRect()
          .right,
        results: document
          .querySelector(".metrics-panel")
          .getBoundingClientRect().right,
      }));
      assert.ok(
        geometry.document <= geometry.width + 1,
        JSON.stringify(geometry),
      );
      assert.ok(
        geometry.header <= geometry.width + 1,
        JSON.stringify(geometry),
      );
      assert.ok(
        geometry.results <= geometry.width + 1,
        JSON.stringify(geometry),
      );
    }
    console.log("Native window layout passed at 900, 1000 and 1280 pixels");

    // 同一批次混合彩色、二值和损坏图片：成功项继续完成，失败项独立显示。
    await page
      .locator('input[accept="image/png,image/jpeg"]')
      .setInputFiles([colorImage, binaryImage, invalid]);
    await page.waitForFunction(
      () => {
        const rows = [
          ...document.querySelectorAll(".batch-list .batch-status"),
        ];
        return (
          rows.length === 3 &&
          rows.every((row) =>
            ["已完成", "无法读取图片，请选择有效的 PNG 或 JPEG"].includes(
              row.textContent,
            ),
          )
        );
      },
      null,
      { timeout: 30000 },
    );
    const records = await page.evaluate(async () =>
      (await fetch("/api/analyses")).json(),
    );
    assert.equal(
      records.filter((record) => record.status === "completed").length,
      2,
    );
    assert.equal(
      records.filter((record) => record.status === "failed").length,
      1,
    );
    const completed = records.filter((record) => record.status === "completed");
    const details = [];
    for (const record of completed) {
      const detail = await page.evaluate(
        async (id) => (await fetch("/api/analyses/" + id)).json(),
        record.id,
      );
      details.push(detail);
    }
    const colorResult = details.find(
      (record) => record.effective_method === "hsv",
    );
    assert.ok(colorResult);
    assert.ok(details.some((record) => record.effective_method === "binary"));
    fs.writeFileSync(
      path.join(outputDir, "trial-results.json"),
      JSON.stringify(details, null, 2),
    );
    console.log(
      "Mixed batch and failure isolation passed:",
      details.map((record) => record.metrics),
    );

    // 通过原生 IPC 导出真实 ZIP，文件对话框只在测试中替换为确定的保存路径。
    const batchPath = path.join(outputDir, "批量试验结果.zip");
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: target,
      });
    }, batchPath);
    await page
      .getByRole("button", { name: "导出整个批次", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.querySelector(".toast")?.textContent?.includes("文件已保存"),
    );
    const archived = unzipSync(fs.readFileSync(batchPath));
    assert.ok(archived["summary.csv"]);
    assert.ok(
      Buffer.from(archived["summary.csv"])
        .toString()
        .includes("invalid.png,failed") ||
        Buffer.from(archived["summary.csv"])
          .toString()
          .includes('invalid.png"' + ",failed"),
    );
    assert.equal(
      Object.keys(archived).filter((name) => name.endsWith("/mask.png")).length,
      2,
    );

    await page
      .locator(".batch-list > button")
      .filter({ hasText: path.basename(colorImage) })
      .first()
      .click();
    const reorderingScreenshot = path.join(outputDir, "湿润层-拖动落位后.png");
    // 原生窗口重新取焦后再开始实际指针手势，避免被其他 Electron 窗口接走焦点。
    await nativeWindow.evaluate((window) => window.focus());
    await verifyCardWorkspace(page, reorderingScreenshot, colorResult);
    // 用物理指针拖动红线。拖动中只有预览，松手后才新增一条历史。
    const wettingDepth = page.locator(".root-controls input");
    const drawing = page.locator(".explorer-drawing");
    await drawing.scrollIntoViewIfNeeded();
    const plot = drawing.locator("image").first();
    const plotBox = await plot.boundingBox();
    const grip = drawing.locator(".explorer-handle circle").first();
    const gripBox = await grip.boundingBox();
    const gripX = gripBox.x + gripBox.width / 2;
    const gripY = gripBox.y + gripBox.height / 2;
    const newY = plotBox.y + plotBox.height * 0.58;
    const posted = [];
    const recordUpload = (request) => {
      const upload =
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/analyses";
      if (upload) posted.push(request);
    };
    page.on("request", recordUpload);
    await page.mouse.move(gripX, gripY);
    await page.mouse.down();
    await page.mouse.move(gripX, newY);
    const expectedDepth = await wettingDepth.inputValue();
    assert.ok(Math.abs(Number(expectedDepth) - 29) < 0.3);
    assert.equal(posted.length, 0);
    await page.mouse.up();
    const progress = page.locator(".depth-progress");
    await progress.waitFor();
    await progress.waitFor({
      state: "hidden",
    });
    assert.equal(posted.length, 1);
    page.off("request", recordUpload);
    assert.equal(await wettingDepth.inputValue(), expectedDepth);

    // 保留原批次，也检查两种输入方式各新增一条独立历史，且导出可继续使用。
    const savedRecords = await page.evaluate(async () => {
      const response = await fetch("/api/analyses");
      return response.json();
    });
    assert.equal(savedRecords.length, records.length + 2);
    const previousIds = savedRecords.map((entry) => entry.id).sort();
    const latest = savedRecords[0];
    const latestResult = await page.evaluate(async (id) => {
      const response = await fetch("/api/analyses/" + id);
      return response.json();
    }, latest.id);
    assert.equal(latestResult.root_zone.root_depth_cm, Number(expectedDepth));
    assert.equal(await page.locator(".batch-list > button").count(), 3);
    await page.getByRole("button", { name: "原图", exact: true }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: path.join(outputDir, "浅色-彩色试验图.png"),
      scale: "css",
      fullPage: true,
    });

    // HSV 新控件同时验证键盘微调、输入自动保存和无效值不覆盖有效设置。
    await page
      .locator("nav")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page.getByRole("tab", { name: "分析参数", exact: true }).click();
    const lowerHue = page.getByRole("slider", {
      name: "H 色相 下限",
      exact: true,
    });
    await lowerHue.focus();
    await lowerHue.press("ArrowRight");
    await page.waitForFunction(
      async () =>
        (await (await fetch("/api/bootstrap")).json()).settings.lower_hsv[0] ===
        36,
    );
    const width = page.getByLabel("实际宽度", { exact: false });
    await width.fill("0");
    await page
      .getByText("请检查分辨率、尺寸及阈值的范围和格式", { exact: true })
      .waitFor();
    const storedWidth = await page.evaluate(
      async () =>
        (await (await fetch("/api/bootstrap")).json()).settings.soil_width_cm,
    );
    assert.equal(storedWidth, 50);
    await width.fill("50");
    await page.getByText("已自动保存", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(outputDir, "设置-HSV双滑块.png"),
      scale: "css",
      fullPage: true,
    });

    // 切换三种降噪算法并实际修改各自参数，重新选回后保留已保存数值。
    const denoiseSwitch = page.getByRole("checkbox", {
      name: "启用图像降噪",
      exact: true,
    });
    const denoiseMethod = page.getByLabel("降噪算法", { exact: true });
    await page.getByLabel("邻域直径", { exact: true }).fill("7");
    await page.getByLabel("颜色尺度 σColor", { exact: true }).fill("30");
    await page.getByLabel("空间尺度 σSpace", { exact: true }).fill("6");
    await page.getByText("已自动保存", { exact: true }).waitFor();
    await denoiseMethod.selectOption("median");
    const medianKernel = page.getByLabel("中值窗口", { exact: true });
    await medianKernel.fill("4");
    await page
      .getByText("降噪窗口须为奇数，搜索窗口须不小于图块窗口", { exact: true })
      .waitFor();
    await medianKernel.fill("5");
    await page.getByText("已自动保存", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(outputDir, "降噪-中值滤波.png"),
      fullPage: true,
    });
    await denoiseMethod.selectOption("nlm");
    await page.getByLabel("亮度降噪强度 h", { exact: true }).fill("3");
    await page.getByLabel("颜色降噪强度 hColor", { exact: true }).fill("4");
    await page.getByLabel("图块窗口", { exact: true }).fill("3");
    await page.getByLabel("搜索窗口", { exact: true }).fill("7");
    await page.getByText("已自动保存", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(outputDir, "降噪-非局部均值.png"),
      fullPage: true,
    });
    await denoiseMethod.selectOption("bilateral");
    assert.equal(
      await page.getByLabel("邻域直径", { exact: true }).inputValue(),
      "7",
    );
    assert.equal(
      await page.getByLabel("颜色尺度 σColor", { exact: true }).inputValue(),
      "30",
    );
    assert.equal(
      await page.getByLabel("空间尺度 σSpace", { exact: true }).inputValue(),
      "6",
    );
    await page.getByText("已自动保存", { exact: true }).waitFor();
    await denoiseSwitch.uncheck();
    await page.getByText("已自动保存", { exact: true }).waitFor();
    assert.equal(await denoiseMethod.isVisible(), false);
    await denoiseSwitch.check();
    await page.getByText("已自动保存", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(outputDir, "降噪-双边滤波.png"),
      fullPage: true,
    });
    // 缩窄真实窗口，核对三种参数表单并保存可直接查看的区域截图。
    await nativeWindow.evaluate((window) => window.setSize(900, 800));
    for (const method of ["bilateral", "median", "nlm"]) {
      await denoiseMethod.selectOption(method);
      await page.getByText("已自动保存", { exact: true }).waitFor();
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      assert.ok(
        geometry.document <= geometry.width + 1,
        JSON.stringify(geometry),
      );
      const section = page.locator(".settings-section").filter({
        has: page.getByRole("heading", { name: "图像降噪", exact: true }),
      });
      await section.screenshot({
        path: path.join(outputDir, `降噪-${method}-窄窗口.png`),
        scale: "css",
      });
    }
    await nativeWindow.evaluate((window) => window.setSize(1280, 800));
    await denoiseMethod.selectOption("bilateral");
    await page.getByText("已自动保存", { exact: true }).waitFor();
    const denoiseSettings = await page.evaluate(
      async () => (await (await fetch("/api/bootstrap")).json()).settings,
    );
    assert.equal(denoiseSettings.denoise_enabled, true);
    assert.equal(denoiseSettings.denoise_method, "bilateral");
    assert.equal(denoiseSettings.median_kernel, 5);
    assert.equal(denoiseSettings.nlm_h, 3);
    assert.equal(denoiseSettings.nlm_h_color, 4);
    assert.equal(denoiseSettings.nlm_template_window, 3);
    assert.equal(denoiseSettings.nlm_search_window, 7);
    console.log(
      "Denoising switch, algorithm selection, per-method parameters and validation passed",
    );

    // 切换语言和外观自动持久化，且不改变已有历史记录。
    await page.getByRole("tab", { name: "外观", exact: true }).click();
    await page.locator(".language-select").selectOption("en-US");
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    await page.getByText("Saved automatically", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await page.getByText("Saved automatically", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(outputDir, "设置-English-夜间.png"),
      scale: "css",
      fullPage: true,
    });
    await page
      .locator("nav")
      .getByRole("button", { name: "Image analysis", exact: true })
      .click();
    await page
      .locator(".batch-list > button")
      .filter({ hasText: path.basename(binaryImage) })
      .first()
      .click();
    await page.getByRole("button", { name: "Binary", exact: true }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: path.join(outputDir, "夜间-English-二值试验图.png"),
      scale: "css",
      fullPage: true,
    });
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page
      .getByRole("heading", { name: "Image analysis", exact: true })
      .waitFor();
    const restored = await page.evaluate(async () =>
      (await fetch("/api/bootstrap")).json(),
    );
    assert.equal(restored.settings.theme, "dark");
    assert.equal(restored.settings.language, "en-US");
    assert.equal(restored.settings.denoise_method, "bilateral");
    assert.equal(restored.settings.bilateral_diameter, 7);
    assert.equal(restored.settings.median_kernel, 5);
    assert.equal(restored.settings.nlm_search_window, 7);
    const restoredRecords = await page.evaluate(async () =>
      (await fetch("/api/analyses")).json(),
    );
    assert.deepEqual(
      restoredRecords.map((record) => record.id).sort(),
      previousIds,
    );
    // 真实文件夹入口保留相对路径，同名图片不会合并或覆盖。
    const folder = path.join(dataDir, "import-folder");
    for (const part of ["first", "second"]) {
      const child = path.join(folder, part);
      fs.mkdirSync(child, { recursive: true });
      fs.copyFileSync(
        part === "first" ? colorImage : binaryImage,
        path.join(child, "same-name.png"),
      );
    }
    await page.locator("input[webkitdirectory]").setInputFiles(folder);
    await page.waitForFunction(
      () => document.querySelectorAll(".batch-status.completed").length === 2,
    );
    const folderRecords = await page.evaluate(async () =>
      (await fetch("/api/analyses")).json(),
    );
    const names = folderRecords
      .filter((record) => record.name.includes("same-name"))
      .map((record) => record.name);
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
    console.log("Folder import with duplicate basenames passed");

    // 一批八张图超过服务的四项队列上限，前端流水线仍能排队且允许取消等待项。
    const cancelFiles = [];
    for (let index = 0; index < 8; index++) {
      const target = path.join(dataDir, "cancel-" + index + ".png");
      fs.copyFileSync(binaryImage, target);
      cancelFiles.push(target);
    }
    await page
      .locator('input[accept="image/png,image/jpeg"]')
      .setInputFiles(cancelFiles);
    await page
      .getByRole("button", { name: "Cancel waiting", exact: true })
      .click();
    await page.waitForFunction(() => {
      const statuses = [...document.querySelectorAll(".batch-status")];
      return (
        statuses.length === 8 &&
        statuses.every((status) =>
          ["Complete", "Cancelled"].includes(status.textContent),
        )
      );
    });
    assert.ok((await page.locator(".batch-status.cancelled").count()) > 0);
    console.log("Batch backpressure and cancellation passed");
    assert.deepEqual(errors, []);
    console.log(
      "Autosave, range slider, localization, dark mode, ZIP export and restart recovery passed",
    );
  } finally {
    await application.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
