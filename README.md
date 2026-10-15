# Anatomy Explorer

A 3D human body in the browser that you can rotate, zoom and peel layer by layer:
**skin → muscles → skeleton → organs → blood vessels → nervous system**.

**Live:** https://adicohen136.github.io/anatomy-explorer/

- Zoom in and the outer layers fade away automatically (toggle "Peel as I zoom in")
- Peel-depth slider, per-layer visibility and opacity
- Click any part (over 60 of them) for what it does and a fun fact
- Beating heart, breathing lungs, and blood pulsing through arteries (red) and veins (blue)
- Cross-section cuts (front-to-back or side-to-side) and an X-ray glow mode
- Deep links: `?view=head&peel=2`, `?view=chest&cut=front`, `?xray=1`

Everything is built procedurally from shapes and curves with [Three.js](https://threejs.org/), with no model files and no backend.
Stylized for learning, not anatomically exact.

Built for Lab 1 of Agentic Programming (HUJI 67723) by talking to Claude Code.
