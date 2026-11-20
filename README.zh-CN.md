<p align="center">
  <img src="packaging/HydroCalc.png" width="112" alt="HydroCalc Neo 标志">
</p>

<h1 align="center">HydroCalc Neo</h1>

<p align="center">用于分析土壤染色剖面优先流的桌面软件。</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

## 从源码运行

需要 Node.js 24、CMake 3.24+ 和 C++17 工具链。macOS 需安装 Xcode 命令行工具和 Ninja。Windows 需安装 Visual Studio 2022 并勾选「使用 C++ 的桌面开发」。

克隆本仓库后，在根目录运行以下命令。

```sh
npm ci
npm run build:native
npm run dev
```

## 分析土壤剖面

1. 设置剖面的实际宽度和深度，导入染色照片或白底黑色的二值掩膜。也可导入文件夹进行批量分析。
2. 查看染色面积、优先流指标和深度曲线。在湿润层视图中拖动深度线或输入数值，确认新深度后，软件会自动重新分析并保存一条独立历史。
3. 在结果中导出图像、CSV 表格、Excel 像素矩阵或 ZIP 压缩包。

设置、分析历史和图片保存在本机。新版会沿用原桌面版的数据目录。

计算细节见[指标定义](docs/METRICS.md)。
