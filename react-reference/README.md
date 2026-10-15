# React reference implementation

This folder is a React/Next.js reference port of the Visual Recovery & Auto-Workout Engine. The deployed Timely Fit app remains the static HTML/CSS/JavaScript implementation in the project root; it does not bundle React.

## Use in Next.js

1. Copy `react-reference/` into your React project.
2. Copy `master_exercises_final_audit.json` and `muscle_map_assets.json` into `public/`.
3. Wrap your workout page in the provider:

```jsx
import { RecoveryEngineProvider } from './recovery-reference/RecoveryEngineProvider.jsx';
import WorkoutGeneratorPanel from './recovery-reference/WorkoutGeneratorPanel.jsx';
import StrengthVolumeHeatmap from './recovery-reference/StrengthVolumeHeatmap.jsx';
import './styles.css'; // or your adaptation of the recovery classes

export default function WorkoutPage() {
  return (
    <RecoveryEngineProvider>
      <WorkoutGeneratorPanel />
      <StrengthVolumeHeatmap />
    </RecoveryEngineProvider>
  );
}
```

4. Reuse the CSS classes from the root `styles.css`, or adapt the selectors to your design tokens.
5. In a full React migration, wire `onInjectRoutine` if your central state/store owns workout changes; otherwise the provider can write to the compatible `forma_local_v1` database's `kv/app_state` record.

## API

- `calculateMuscleState({ logs, auditExercises, mapAssets, now? })`
- `calculateVolumeHeatmap({ logs, auditExercises, mapAssets, now? })`
- `getLastUsedWeight(exerciseOrId, { logs, auditExercises })`
- `generateRoutine({ selectedSlugs, statusBySlug, equipment, auditExercises, logs })`
- `WorkoutGeneratorMap` — reusable interactive or read-only map.
- `WorkoutGeneratorPanel` — selection and auto routine workflow.
- `StrengthVolumeHeatmap` — analytics view using the same body map.

All muscle matching is strict: `muscle_map_slugs` from the audit JSON is the sole source. Unknown or ambiguous exercise matches are not mapped by guessing the `target` or `body_part` strings.
