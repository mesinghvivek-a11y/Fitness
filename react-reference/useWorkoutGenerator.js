/* React / React Native hook around workout-engine.js.
 * Keeps `previouslyGeneratedIds` in a ref so Rule A (progressive pool) works across many Generate clicks.
 *
 *   const { exercises, generate, reset, shortfall, reason } = useWorkoutGenerator(exercisesEnriched);
 *   generate({ muscle: 'Biceps', equipment: ['Barbell'], count: 3,
 *              includeUnilateral: false, includeTier23: false, availableSetups: ['flat_bench'] });
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import Engine from '../workout-engine.js';

export function useWorkoutGenerator(database) {
  const sessionRef = useRef(null);
  if (!sessionRef.current) sessionRef.current = Engine.createGeneratorSession();   // survives re-renders
  const [result, setResult] = useState(null);

  const generate = useCallback(({ muscle, equipment, count, ...settings }) => {
    const r = sessionRef.current.generate(muscle, equipment, count, { database, ...settings });
    setResult(r);
    return r;
  }, [database]);

  const reset = useCallback(() => { sessionRef.current.reset(); setResult(null); }, []);
  const setups = useMemo(() => Engine.listSetups(database), [database]);

  return {
    exercises: result ? result.exercises : [],
    shortfall: result ? result.shortfall : 0,
    reason: result ? result.reason : null,       // 'ok' | 'no_matches' | 'variation_limited' | 'pool_exhausted' | 'invalid_request'
    hidden: result ? result.hidden : null,       // what the unilateral / setup / tier settings are hiding
    generate, reset, setups,
    seenCount: () => sessionRef.current.size()
  };
}
