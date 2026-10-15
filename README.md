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

The skin, muscles, bones, organs, brain and trunk vessels are real anatomical meshes from
[BodyParts3D](https://lifesciencedb.jp/bp3d/), © The Database Center for Life Science, licensed
[CC BY-SA 2.1 JP](https://creativecommons.org/licenses/by-sa/2.1/jp/deed.en). They were simplified and converted
with `tools/build_models.py`. The limb vessels, nerves and spinal cord are generated along the real bones.
Rendered with [Three.js](https://threejs.org/); no backend.

Built for Lab 1 of Agentic Programming (HUJI 67723) by talking to Claude Code.
