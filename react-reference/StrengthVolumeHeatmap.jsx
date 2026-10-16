import React, { useMemo, useState } from 'react';
import { useRecoveryEngine } from './RecoveryEngineProvider.jsx';
import { calculateVolumeHeatmap } from './recoveryEngine.js';
import WorkoutGeneratorMap from './WorkoutGeneratorMap.jsx';

export default function StrengthVolumeHeatmap() {
  const engine = useRecoveryEngine();
  const [side, setSide] = useState('front');
  const heatmap = useMemo(() => calculateVolumeHeatmap({ logs: engine.logs, auditExercises: engine.auditExercises, mapAssets: engine.mapAssets }), [engine.logs, engine.auditExercises, engine.mapAssets]);
  const leaders = Object.entries(heatmap.volumeBySlug).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const data = heatmap[side] || [];
  return (
    <section className="analysis-card recovery-volume-card">
      <div className="analysis-card-head"><div><div className="analysis-card-title">Strength volume heatmap</div><div className="analysis-card-sub">Weighted volume by audited muscle slug · last 30 days</div></div><span className="card-badge">30 DAYS</span></div>
      <div className="recovery-map-toolbar"><div className="segmented-choice"><button type="button" className={side === 'front' ? 'active' : ''} onClick={() => setSide('front')}>Front</button><button type="button" className={side === 'back' ? 'active' : ''} onClick={() => setSide('back')}>Back</button></div><span className="volume-heatmap-gradient"><i /><small>Low</small><small>High</small></span></div>
      <div className={`recovery-body-map-wrap volume-heatmap-map ${side === 'back' ? 'back' : ''}`}><WorkoutGeneratorMap side={side} data={data} selectedSlugs={[]} interactive={false} /></div>
      <div className="volume-heatmap-totals"><div><strong>{Math.round(heatmap.totalVolume).toLocaleString()} kg</strong><span>Total counted volume</span></div><div><strong>{heatmap.completedWeightedSets.toLocaleString()}</strong><span>Weighted sets</span></div></div>
      {leaders.length > 0 ? <div className="volume-leader-list">{leaders.map(([slug, volume], index) => <div className="volume-leader" key={slug}><span className="volume-leader-rank">{index + 1}</span><span>{slug.replaceAll('-', ' ')}</span><strong>{Math.round(volume).toLocaleString()} kg</strong></div>)}</div> : <p className="recovery-data-note">Complete weighted sets during the last 30 days to build this heatmap. Bodyweight sets with no recorded external load are excluded from kg volume.</p>}
    </section>
  );
}
