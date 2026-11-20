<p align="center">
  <img src="packaging/HydroCalc.png" width="112" alt="HydroCalc Neo logo">
</p>

<h1 align="center">HydroCalc Neo</h1>

<p align="center">A desktop app for analyzing preferential flow in stained soil profiles.</p>

<p align="center">
  <a href="https://github.com/lnk137/HydroCalc-Neo/actions/workflows/desktop.yml"><img src="https://github.com/lnk137/HydroCalc-Neo/actions/workflows/desktop.yml/badge.svg?branch=main" alt="Desktop build status"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows-2F766D?logo=electron&amp;logoColor=white" alt="Desktop platforms: macOS and Windows"></a>
  <a href="https://nodejs.org/en/download"><img src="https://img.shields.io/badge/Node.js-24-417E38?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24"></a>
</p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

![HydroCalc Neo showing a color-coded soil profile, depth curves, and analysis indicators](docs/media/analysis-workspace.png)

*The screenshots and demos use synthetic soil profiles.*

## Features

- **Calibrate and segment.** Enter the profile's measured width and depth. Import a stained PNG or JPEG and adjust HSV thresholds and denoising, or analyze a black-on-white mask directly.
- **Inspect preferential flow.** Measure stained area, preferential flow percentage, matrix flow depth, and maximum staining depth. Compare the original image, binary mask, reference lines, and K-means results.
- **Explore the wetting zone.** View the stained profile and depth curve on a shared scale. Drag the wetting boundary to preview how deep percolation loss (RDPR), irrigation efficiency (Ea), and effective storage (Es) change. Pin depths to compare them.
- **Run batches and revisit results.** Import multiple images or an entire folder, check each item's status, and open earlier results with their saved settings. Settings, images, and history stay on your device. HydroCalc Neo reads data from the previous desktop version.
- **Export the data you need.** Save images and profile figures as PNG, indicators and depth profiles as CSV, pixel matrices as Excel, or an entire batch as a ZIP with a summary CSV.

See the [metric definitions](docs/METRICS.md) for formulas and units.

## Quick start

Requires Node.js 24, CMake 3.24+, and a C++17 toolchain. On macOS, install the Xcode Command Line Tools and Ninja. On Windows, install Visual Studio 2022 with the Desktop development with C++ workload.

Clone this repository and run these commands from its root:

```sh
npm ci
npm run build:native
npm run dev
```

In **Analysis settings**, enter the profile dimensions and import your first image. Open **Wetting zone** to adjust the planned wetting depth, or choose an export format in the toolbar.

## Demos

### Adjust the wetting depth

Drag the red line to preview the updated metrics. Releasing it reruns the analysis and saves a separate history entry.

![Dragging the wetting boundary from 36 to 28 cm updates the profile and adds a history entry](docs/media/wetting-depth.gif)

### Analyze and export a batch

Import multiple profiles, switch between their results, and save the batch as a ZIP.

![Three profiles are analyzed, one result is selected, and the batch archive is saved](docs/media/batch-export.gif)

### Export a profile figure

Choose **Profile figure (PNG)** to save the annotated profile, depth curves, and indicators in one image.

<p align="center">
  <img src="docs/media/profile-figure.png" width="740" alt="Exported figure with a stained profile, 28 cm wetting boundary, depth curves, and root-zone indicators">
</p>
