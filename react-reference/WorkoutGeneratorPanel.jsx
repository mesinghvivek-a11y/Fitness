import React from 'react';
import { useRecoveryEngine } from './RecoveryEngineProvider.jsx';
import WorkoutGeneratorMap from './WorkoutGeneratorMap.jsx';

export default function WorkoutGeneratorPanel() {
  const engine = useRecoveryEngine();
  const statuses = engine.recovery.statusBySlug || {};
  const counts = Object.values(statuses).reduce((all, status) => ({ ...all, [status]: (all[status] || 0) + 1 }), { fresh: 0, recovering: 0, exhausted: 0 });
  const equipmentOptions = ['Any equipment', ...new Set(engine.auditExercises.map((item) => item.equipment).filter(Boolean).sort((a, b) => a.localeCompare(b)))];

  const safeGenerate = () => {
    try { engine.generate(); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Could not generate a routine.'); }
  };
  const safeInject = async () => {
    try { await engine.injectRoutine(); window.alert('Routine added to today’s training session.'); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Could not save this routine.'); }
  };

  if (engine.loading) return <section className="recovery-engine-panel"><p>Loading audited exercise and body-map data…</p></section>;
  if (engine.error && !engine.auditExercises.length) return <section className="recovery-engine-panel" role="alert"><p>{engine.error}</p></section>;

  return (
    <section className="recovery-engine-panel">
      <header className="recovery-engine-heading"><div><span className="eyebrow">SMART TRAINING</span><h2>Recovery & Auto-workout</h2><p>Training associations use only the audited JSON muscle slugs.</p></div></header>
      <div className="recovery-status-strip">
        <div><i className="recovery-dot fresh" /><b>{counts.fresh}</b><span>Fresh</span></div>
        <div><i className="recovery-dot recovering" /><b>{counts.recovering}</b><span>Recovering</span></div>
        <div><i className="recovery-dot exhausted" /><b>{counts.exhausted}</b><span>Exhausted</span></div>
      </div>
      <div className="recovery-map-toolbar">
        <div className="segmented-choice"><button type="button" className={engine.side === 'front' ? 'active' : ''} onClick={() => engine.setSide('front')}>Front</button><button type="button" className={engine.side === 'back' ? 'active' : ''} onClick={() => engine.setSide('back')}>Back</button></div>
        <button type="button" className="subtle-action" onClick={() => { try { engine.autoSelectFresh(); } catch (error) { window.alert(error.message); } }}>Auto-select 3 fresh</button>
      </div>
      <div className={`recovery-body-map-wrap ${engine.side === 'back' ? 'back' : ''}`}><WorkoutGeneratorMap /></div>
      <div className="recovery-legend"><span><i style={{ background: '#ef4444' }} />Exhausted &lt;24h</span><span><i style={{ background: '#eab308' }} />Recovering 24–48h</span><span><i style={{ background: '#22c55e' }} />Fresh &gt;48h</span><span><i style={{ background: '#3b82f6' }} />Selected</span></div>
      <div className="recovery-selected-list">{engine.selectedSlugs.length ? engine.selectedSlugs.map((slug) => <button className="recovery-selected-chip" type="button" key={slug} onClick={() => engine.setSelectedSlugs((current) => current.filter((value) => value !== slug))}>{slug.replaceAll('-', ' ')} <span>×</span></button>) : <span className="recovery-selection-hint">Select muscles on the map, or generate to auto-select three fresh muscle groups.</span>}</div>
      <label className="recovery-equipment-label" htmlFor="recovery-equipment-react">Equipment</label>
      <select id="recovery-equipment-react" value={engine.equipment} onChange={(event) => engine.setEquipment(event.target.value)}>{equipmentOptions.map((option) => <option value={option} key={option}>{option}</option>)}</select>
      <button type="button" className="primary-button" onClick={safeGenerate}>Generate routine</button>
      {engine.routine.length > 0 && <section className="recovery-routine"><div className="recovery-section-heading"><h3>Today’s routine</h3><span>{engine.routine.length} exercises</span></div>
        {engine.routine.map((item, index) => <article className="recovery-routine-item" key={item.id}><div className="recovery-routine-media">{item.image ? <img src={item.image} alt="" onError={(event) => { event.currentTarget.hidden = true; }} /> : '🏋️'}</div><div className="recovery-routine-main"><strong>{item.name}</strong><span>{item.equipment} · {item.body_part || item.target}</span><small>4 sets × 12 reps</small>{String(item.equipment).toLowerCase() === 'bodyweight' ? <span>Bodyweight · no external load</span> : <input type="number" min="0" step="2.5" value={item.weightInput} placeholder={item.lastWeight != null ? `Last: ${item.lastWeight} kg` : 'Weight (kg)'} aria-label={`Starting weight for ${item.name}`} onChange={(event) => engine.updateRoutineWeight(item.id, event.target.value)} />}</div><span className="recovery-routine-index">{String(index + 1).padStart(2, '0')}</span></article>)}
        <button type="button" className="primary-button recovery-inject-button" onClick={safeInject}>Add exercises to today’s session</button>
      </section>}
    </section>
  );
}
