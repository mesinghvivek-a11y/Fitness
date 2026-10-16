import React from 'react';
import { useRecoveryEngine } from './RecoveryEngineProvider.jsx';

/** Web SVG version of the body map. Only audit slugs are tappable/selectable. */
export default function WorkoutGeneratorMap({ interactive = true, data, selectedSlugs, side }) {
  const engine = useRecoveryEngine();
  const currentSide = side || engine.side;
  const currentData = data || engine.recovery[currentSide];
  const selected = new Set(selectedSlugs || engine.selectedSlugs);
  const colorsBySlug = new Map((currentData || []).filter((entry) => engine.validSlugs.has(entry.slug)).map((entry) => [entry.slug, entry.color]));
  const parts = engine.mapAssets?.[currentSide] || [];
  const viewBox = currentSide === 'front' ? '0 0 724 1448' : '724 0 724 1448';
  const pressSlug = (slug) => { if (interactive && engine.validSlugs.has(slug)) engine.toggleMuscle(slug); };

  return (
    <svg className="recovery-body-svg" viewBox={viewBox} role="img" aria-label={`${currentSide} muscle map`}>
      {parts.map((part) => {
        const slug = part.slug;
        const valid = engine.validSlugs.has(slug);
        const isSelected = selected.has(slug);
        const fill = isSelected ? engine.RECOVERY_COLORS.selected : (colorsBySlug.get(slug) || '#dce2dd');
        const paths = [...(part.path?.common || []), ...(part.path?.left || []), ...(part.path?.right || [])];
        return (
          <g
            key={slug}
            className={`recovery-muscle-shape${valid ? '' : ' recovery-muscle-neutral'}${isSelected ? ' is-selected' : ''}${interactive && valid ? ' is-interactive' : ''}`}
            role={interactive && valid ? 'button' : undefined}
            tabIndex={interactive && valid ? 0 : undefined}
            aria-label={interactive && valid ? `Select ${slug}` : undefined}
            onClick={() => pressSlug(slug)}
            onKeyDown={(event) => {
              if (!interactive || !valid || !['Enter', ' '].includes(event.key)) return;
              event.preventDefault();
              pressSlug(slug);
            }}
          >
            {paths.map((path, index) => <path key={`${slug}-${index}`} d={path} fill={fill} stroke="#849088" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
          </g>
        );
      })}
    </svg>
  );
}
