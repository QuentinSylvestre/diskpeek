// D3 squarified treemap panel
const MAX_CHILDREN = 100;
const TRANSITION_NAME = 'treemap';
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

function fmtBytes(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
}

export function renderTreemap(focusPath, nodes, scanning = false) {
  if (typeof d3 === 'undefined') {
    const container = document.getElementById('treemap-container');
    if (container) container.innerHTML = '<p style="color:#f87171;padding:8px">D3 failed to load. Check your internet connection.</p>';
    return;
  }

  const container = document.getElementById('treemap-container');
  if (!container) return;
  const W = container.clientWidth, H = container.clientHeight;
  if (W < 10 || H < 10) return;

  const tooltip = document.getElementById('treemap-tooltip') || (() => {
    const t = document.createElement('div');
    t.id = 'treemap-tooltip'; t.className = 'treemap-tooltip';
    document.body.appendChild(t); return t;
  })();
  tooltip.style.display = 'none';

  // Interrupt any in-progress named transition
  const oldSvg = container.querySelector('svg');
  if (oldSvg) d3.select(oldSvg).selectAll('rect').interrupt(TRANSITION_NAME);

  const svg = d3.select(container).selectAll('svg').data([null]);
  const svgEl = svg.enter().append('svg').merge(svg).attr('width', W).attr('height', H);
  svgEl.selectAll('*').remove();

  // Scanning indicator
  if (scanning) {
    svgEl.append('text').attr('x', 8).attr('y', H - 8).attr('fill', 'var(--foreground, #e8e8f0)').attr('font-size', '11').text('Scanning...');
  }

  if (!focusPath || !nodes) return;
  const node = nodes.get(focusPath);
  if (!node) return;

  // Get children, sort by size, cap at MAX_CHILDREN
  let children = (node.children || []).map(p => nodes.get(p)).filter(Boolean).filter(c => c.size > 0);
  children.sort((a, b) => b.size - a.size);
  if (children.length > MAX_CHILDREN) {
    const rest = children.splice(MAX_CHILDREN - 1);
    const hiddenSize = rest.reduce((s, c) => s + c.size, 0);
    children.push({ path: '__other__', name: '(' + rest.length + ' other items)', size: hiddenSize, is_dir: false, category: null });
  }
  if (children.length === 0) {
    if (!scanning) svgEl.append('text').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').attr('fill', 'var(--foreground, #e8e8f0)').attr('opacity', 0.5).text('No children to display');
    return;
  }

  // Expand only the synthetic top node: scanned nodes carry their own `children`
  // (path strings), which d3's default accessor would turn into size-less leaves,
  // collapsing every non-empty directory to zero area.
  const top = { children };
  const root = d3.hierarchy(top, d => (d === top ? d.children : null))
    .sum(d => d.size).sort((a, b) => b.value - a.value);
  d3.treemap().tile(d3.treemapSquarify).size([W, H]).padding(2)(root);

  const dur = REDUCED_MOTION.matches ? 0 : 200;

  const cells = svgEl.selectAll('g.treemap-cell').data(root.leaves());
  const enter = cells.enter().append('g').attr('class', 'treemap-cell')
    .classed('selected', d => d.data.path === focusPath)
    .attr('transform', d => `translate(${d.x0},${d.y0})`);

  enter.append('rect')
    .attr('width', d => Math.max(0, d.x1 - d.x0))
    .attr('height', d => Math.max(0, d.y1 - d.y0))
    .attr('fill', d => d.data.is_dir ? 'var(--viz-series-1, #4a9eff)' : 'var(--viz-series-2, #888)')
    .attr('fill-opacity', 0)
    .on('mousemove', (ev, d) => {
      tooltip.style.display = 'block';
      tooltip.style.left = (ev.clientX + 12) + 'px';
      tooltip.style.top = (ev.clientY + 12) + 'px';
      tooltip.textContent = (d.data.path !== '__other__' ? d.data.path : d.data.name) + ' \u2014 ' + fmtBytes(d.data.size);
    })
    .on('mouseleave', () => { tooltip.style.display = 'none'; })
    .on('click', (ev, d) => {
      if (d.data.path === '__other__') return;
      if (window.app && window.app.selectNode) window.app.selectNode(d.data.path);
    })
    .transition(d3.transition(TRANSITION_NAME).duration(dur))
    .attr('fill-opacity', 1);

  // Labels for cells wide enough
  enter.filter(d => (d.x1 - d.x0) > 60).append('text')
    .attr('x', 4).attr('y', 14)
    .attr('fill', '#fff').attr('font-size', '11').attr('pointer-events', 'none')
    .text(d => {
      const w = d.x1 - d.x0 - 8;
      const s = d.data.name + ' ' + fmtBytes(d.data.size);
      return s.length > Math.floor(w / 6) ? s.slice(0, Math.floor(w / 6)) + '\u2026' : s;
    });
}
