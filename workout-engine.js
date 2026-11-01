/* Timely Fit — Auto-Workout Generator engine.
 *
 * A pure, dependency-free module (no DOM, no app state). It runs in the browser
 * (window.TimelyWorkoutEngine), in Node (require) and inside a React / React Native
 * bundle (import). The app passes its exercise database in; nothing here reads globals.
 *
 * Exercise metadata used (from exercises_enriched.json):
 *   tier            1 = Foundation, 2 = Variation, 3 = Complex / niche
 *   base_family     groups similar movements ("bench_press", "curl", "squat" …)
 *   angle           vector of the movement ("flat", "incline", "neutral", "lateral" …)
 *   mechanic        "compound" | "isolation"
 *   unilateral      true | false
 *   equipment_setup "none" | "flat_bench" | "stability_ball" | …
 *
 * The four rules
 *   A  Progressive pool   Tier 1 first, previously generated ids are excluded on the next
 *                         click, Tier 2 (and 3 when enabled) fills silently when Tier 1 runs dry.
 *   B  Variation killer   Never two exercises with the same base_family AND the same angle.
 *   C  Compound first     compound moves first, isolation last (stable).
 *   D  Setup filtering    equipment_setup other than "none" needs to be in availableSetups.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimelyWorkoutEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ constants */

  /** Hard ceiling so a bad caller can never ask for an absurd routine. */
  var MAX_EXERCISES = 50;
  /** Tier used when an exercise has no (or an invalid) tier, e.g. a hand-made custom exercise. */
  var DEFAULT_TIER = 2;
  /** Families that are a catch-all rather than a real movement family (see varietyKey). */
  var CATCH_ALL_FAMILY = 'other';

  /** Friendly labels for the equipment_setup values, in the order they are shown. */
  var SETUP_LABELS = {
    flat_bench: 'Flat bench',
    incline_bench: 'Incline bench',
    decline_bench: 'Decline bench',
    preacher_bench: 'Preacher bench',
    stability_ball: 'Stability ball',
    box: 'Box / step'
  };

  /* ------------------------------------------------------------------ small helpers */

  /** Accepts undefined | string | array | Set and returns a clean array of non-empty strings. */
  function toList(value) {
    if (value == null) return [];
    var arr = typeof value === 'string' ? [value] : Array.from(value);
    return arr.filter(function (v) { return typeof v === 'string' && v.trim() !== ''; });
  }

  /** Accepts undefined | array | Set and returns a Set (never mutates the caller's collection). */
  function toSet(value) { return new Set(value == null ? [] : Array.from(value)); }

  /** Lower-cases and trims so "Barbell" and " barbell " compare equal. */
  function norm(value) { return String(value == null ? '' : value).trim().toLowerCase(); }

  /**
   * Unbiased Fisher–Yates shuffle. Works on a copy, so the caller's array is never mutated.
   * `rng` is injectable (must return a number in [0,1)) which makes the engine testable.
   */
  function fisherYates(list, rng) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function tierOf(ex) {
    var t = Number(ex && ex.tier);
    return t === 1 || t === 2 || t === 3 ? t : DEFAULT_TIER;
  }

  /** Anything that is not literally "compound" is treated as isolation (unlabelled moves go last). */
  function mechanicOf(ex) { return ex && ex.mechanic === 'compound' ? 'compound' : 'isolation'; }

  function setupOf(ex) {
    var s = ex && ex.equipment_setup;
    return s && s !== 'none' ? String(s) : 'none';
  }

  /**
   * Reduces a name to its movement stem ("Dumbbell Hammer Curl" -> "hammer curl").
   * Only used for exercises whose base_family is the catch-all "other", so that two
   * different unclassified moves are not treated as the same family.
   */
  function movementStem(name) {
    return String(name || '').toLowerCase()
      .replace(/\(.*?\)/g, '')
      .replace(/\b(dumbbells?|barbell|ez[- ]?(bar|barbell)|olympic|cable|lever(age)?|machine|smith|kettlebell|bands?|resistance|assisted|weighted|seated|standing|lying|kneeling|one|single|two|arms?|alternate|alternating|v\.?\s?\d|rope|bosu|stability|ball|medicine|sled|hammer|bodyweight|with|on|the)\b/g, '')
      .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Default muscle resolver: the exercise's primary muscle, lower-cased.
   * The app passes its own `muscleOf` (the canonical muscle names used by the body map).
   */
  function defaultMuscleOf(ex) { return norm(ex && (ex.primary_muscle || ex.target || ex.body_part)); }

  /**
   * Rule B key: base_family + angle.
   * A family of "other" (or a missing one) means "not classified", not "the same movement".
   * Taken literally, every unclassified exercise would collide with every other one and a
   * batch could hold only one of them. So for those, the movement stem stands in for the family.
   * `literalFamilies: true` switches this off and uses base_family exactly as stored.
   */
  function varietyKey(ex, literalFamilies) {
    var fam = norm(ex && ex.base_family);
    var angle = norm(ex && ex.angle) || 'neutral';
    if (!fam || (fam === CATCH_ALL_FAMILY && !literalFamilies)) fam = CATCH_ALL_FAMILY + ':' + movementStem(ex && ex.name);
    return fam + '|' + angle;
  }

  /**
   * Splits `total` across `n` buckets as evenly as possible; earlier buckets get the remainder.
   * distribute(7, 3) -> [3, 2, 2]
   */
  function distribute(total, n) {
    var out = [], base = n ? Math.floor(total / n) : 0, extra = n ? total - base * n : 0;
    for (var i = 0; i < n; i++) out.push(base + (i < extra ? 1 : 0));
    return out;
  }

  /* ------------------------------------------------------------------ Rule C */

  /**
   * Rule C — compound first, isolation last. Stable: the relative order inside each group is kept.
   * `getExercise` lets callers sort wrapper objects (e.g. plan rows) by their exercise.
   */
  function sortCompoundFirst(list, getExercise) {
    var get = getExercise || function (x) { return x; };
    return list
      .map(function (item, i) { return { item: item, i: i, rank: mechanicOf(get(item)) === 'compound' ? 0 : 1 }; })
      .sort(function (a, b) { return a.rank - b.rank || a.i - b.i; })
      .map(function (w) { return w.item; });
  }

  /* ------------------------------------------------------------------ filtering (Rules A tiers + D) */

  /**
   * Builds the eligible pool: right muscle, right equipment, allowed setup (Rule D),
   * unilateral only if enabled, tier 3 only if enabled, and nothing the caller excluded.
   * Also counts what the settings hid, so the UI can say "3 more need an incline bench".
   */
  function buildEligible(database, ctx) {
    var out = [], hidden = { setups: 0, unilateral: 0, tiers: 0 }, seenIds = new Set();
    for (var i = 0; i < database.length; i++) {
      var ex = database[i];
      if (!ex || ex.id == null || seenIds.has(ex.id)) continue;           // skip junk and duplicate ids
      seenIds.add(ex.id);
      if (ctx.excluded.has(ex.id)) continue;                              // hidden / explicitly excluded
      var m = ctx.muscleOf(ex);
      if (!m || !ctx.muscleSet.has(norm(m))) continue;                    // wrong muscle
      if (ctx.equipmentSet && !ctx.equipmentSet.has(norm(ex.equipment))) continue; // wrong equipment
      if (ctx.customFilter && !ctx.customFilter(ex)) continue;
      if (setupOf(ex) !== 'none' && !ctx.setups.has(setupOf(ex))) { hidden.setups++; continue; }   // Rule D
      if (ex.unilateral === true && !ctx.includeUnilateral) { hidden.unilateral++; continue; }
      var t = tierOf(ex);
      if (t === 3 && !ctx.includeTier23) { hidden.tiers++; continue; }
      out.push({ ex: ex, tier: t, muscle: norm(m) });
    }
    return { eligible: out, hidden: hidden };
  }

  /* ------------------------------------------------------------------ selection core */

  /**
   * One selection pass over `pool` (already history-filtered). Fills up to `need` slots.
   *
   * Order of play (Rule A): tier stages in order. Inside a stage the muscles take turns, each
   * limited to its quota, so a 6-exercise chest + back routine is 3 + 3 rather than all chest.
   * A muscle that cannot use its quota hands the slots back, and a second uncapped pass uses them.
   * Rule B is enforced in `take`, which skips any candidate whose family+angle is already used.
   */
  function selectFromPool(pool, need, ctx, keep) {
    var selected = [], taken = new Set(keep.map(function (e) { return e.id; }));
    var usedKeys = new Set(keep.map(function (e) { return varietyKey(e, ctx.literalFamilies); }));
    var usedStems = new Set(keep.map(function (e) { return movementStem(e.name); }));
    var equipCount = {};
    keep.forEach(function (e) { var q = norm(e.equipment); equipCount[q] = (equipCount[q] || 0) + 1; });
    var blockedIds = new Set(), relaxedPicks = 0;

    // Shuffle ONCE per muscle (Fisher–Yates), then bucket by the caller's preference rank
    // (favourites first, recently-used last). The sort is stable, so inside a bucket the order stays random.
    var lists = {};
    ctx.muscles.forEach(function (m) {
      var mine = pool.filter(function (c) { return c.muscle === m; });
      var shuffled = fisherYates(mine, ctx.rng);
      if (ctx.rank) {
        shuffled = shuffled
          .map(function (c, i) { return { c: c, i: i, r: Number(ctx.rank(c.ex)) || 0 }; })
          .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
          .map(function (w) { return w.c; });
      }
      lists[m] = shuffled;
    });

    /** Picks the next candidate for a muscle inside a tier stage, or null. */
    function take(muscle, stageTiers, relaxed) {
      var free = [];
      var list = lists[muscle] || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (taken.has(c.ex.id) || stageTiers.indexOf(c.tier) === -1) continue;
        if (!relaxed && usedKeys.has(varietyKey(c.ex, ctx.literalFamilies))) { blockedIds.add(c.ex.id); continue; }
        free.push(c);
      }
      if (!free.length) return null;
      if (relaxed) {                                   // relaxed: still prefer a movement we have not used
        var fresh = free.filter(function (c) { return !usedStems.has(movementStem(c.ex.name)); });
        if (fresh.length) free = fresh;
      }
      // Use every selected equipment: among the free candidates prefer the least-used equipment.
      var least = Math.min.apply(null, free.map(function (c) { return equipCount[norm(c.ex.equipment)] || 0; }));
      var pick = free.filter(function (c) { return (equipCount[norm(c.ex.equipment)] || 0) === least; })[0];
      taken.add(pick.ex.id);
      if (relaxed && usedKeys.has(varietyKey(pick.ex, ctx.literalFamilies))) relaxedPicks++;   // Rule B knowingly bent
      usedKeys.add(varietyKey(pick.ex, ctx.literalFamilies));
      usedStems.add(movementStem(pick.ex.name));
      var q = norm(pick.ex.equipment); equipCount[q] = (equipCount[q] || 0) + 1;
      selected.push(pick);
      return pick;
    }

    function runPhase(relaxed) {
      var availableMuscles = ctx.muscles.filter(function (m) { return (lists[m] || []).length; });
      var quota = {}, got = {};
      distribute(need, availableMuscles.length).forEach(function (q, i) { quota[availableMuscles[i]] = q; got[availableMuscles[i]] = 0; });

      // pass 1 — respect the per-muscle quota; pass 2 — hand unused slots to whoever can still fill them
      [true, false].forEach(function (capped) {
        ctx.stages.forEach(function (stageTiers) {
          var progressed = true;
          while (selected.length < need && progressed) {
            progressed = false;
            for (var k = 0; k < availableMuscles.length && selected.length < need; k++) {
              var m = availableMuscles[k];
              if (capped && got[m] >= quota[m]) continue;
              if (take(m, stageTiers, relaxed)) { got[m]++; progressed = true; }
            }
          }
        });
      });
    }

    runPhase(false);
    if (selected.length < need && ctx.relaxVariation) runPhase(true);   // opt-in only
    return { selected: selected.map(function (c) { return c.ex; }), blockedIds: blockedIds, relaxedUsed: relaxedPicks > 0 };
  }

  /* ------------------------------------------------------------------ public: generateExercises */

  /**
   * generateExercises(targetMuscle, equipment, numExercises, userSettings)
   *
   * @param {string|string[]} targetMuscle   one muscle or several, e.g. "biceps" or ["Chest","Triceps"]
   * @param {string|string[]} equipment      e.g. "Barbell" or ["Barbell","Dumbbell"]; empty = any equipment
   * @param {number}          numExercises   how many exercises to return
   * @param {object}          userSettings
   * @param {object[]} userSettings.database            exercise records (exercises_enriched.json)
   * @param {boolean}  [userSettings.includeUnilateral=false]
   * @param {boolean}  [userSettings.includeTier23=false]   adds tier 3 to the fallback stage
   * @param {string[]} [userSettings.availableSetups=[]]    e.g. ["flat_bench","stability_ball"]
   * @param {Iterable<string>} [userSettings.previouslyGeneratedIds]  Rule A session memory
   * @param {Iterable<string>} [userSettings.excludeIds]    always excluded (e.g. hidden exercises)
   * @param {object[]} [userSettings.keep]                  exercises already in the routine (locked/manual)
   * @param {function} [userSettings.muscleOf]              ex => muscle name (defaults to primary_muscle)
   * @param {function} [userSettings.rank]                  ex => number, lower comes first (favourites)
   * @param {function} [userSettings.filter]                extra predicate, return false to drop an exercise
   * @param {boolean}  [userSettings.relaxVariation=false]  top up a shortfall by relaxing Rule B (opt-in)
   * @param {boolean}  [userSettings.literalFamilies=false] treat base_family "other" as a real family
   * @param {function} [userSettings.rng=Math.random]
   *
   * @returns {{
   *   exercises: object[], requested: number, shortfall: number,
   *   reason: 'ok'|'no_matches'|'variation_limited'|'pool_exhausted'|'invalid_request',
   *   tierBreakdown: {1:number,2:number,3:number},
   *   cycleRestarted: boolean, relaxedUsed: boolean,
   *   nextPreviousIds: string[], hidden: {setups:number,unilateral:number,tiers:number},
   *   eligibleCount: number, blockedByVariation: number
   * }}
   */
  function generateExercises(targetMuscle, equipment, numExercises, userSettings) {
    var s = userSettings || {};
    var requested = Math.floor(Number(numExercises));
    var emptyResult = function (reason, extra) {
      return Object.assign({
        exercises: [], requested: Number.isFinite(requested) ? Math.max(0, requested) : 0,
        shortfall: Number.isFinite(requested) ? Math.max(0, requested) : 0, reason: reason,
        tierBreakdown: { 1: 0, 2: 0, 3: 0 }, cycleRestarted: false, relaxedUsed: false,
        nextPreviousIds: Array.from(toSet(s.previouslyGeneratedIds)),
        hidden: { setups: 0, unilateral: 0, tiers: 0 }, eligibleCount: 0, blockedByVariation: 0
      }, extra || {});
    };

    // ---- edge cases first: never throw on bad input, always return the same shape
    if (!Number.isFinite(requested) || requested < 1) return emptyResult('invalid_request');
    requested = Math.min(requested, MAX_EXERCISES);
    var database = Array.isArray(s.database) ? s.database : [];
    var muscles = toList(targetMuscle).map(norm);
    muscles = muscles.filter(function (m, i) { return muscles.indexOf(m) === i; });   // de-duplicate, keep order
    if (!database.length || !muscles.length) return emptyResult('no_matches');

    var keep = Array.isArray(s.keep) ? s.keep.filter(Boolean) : [];
    var equipmentList = toList(equipment).filter(function (q) { return q !== '*'; });
    var ctx = {
      muscles: muscles, muscleSet: new Set(muscles),
      muscleOf: typeof s.muscleOf === 'function' ? s.muscleOf : defaultMuscleOf,
      equipmentSet: equipmentList.length ? new Set(equipmentList.map(norm)) : null,
      setups: new Set(toList(s.availableSetups).filter(function (v) { return v !== 'none'; })),
      includeUnilateral: !!s.includeUnilateral,
      includeTier23: !!s.includeTier23,
      excluded: new Set(Array.from(toSet(s.excludeIds)).concat(keep.map(function (e) { return e.id; }))),
      customFilter: typeof s.filter === 'function' ? s.filter : null,
      rank: typeof s.rank === 'function' ? s.rank : null,
      rng: typeof s.rng === 'function' ? s.rng : Math.random,
      literalFamilies: !!s.literalFamilies,
      relaxVariation: !!s.relaxVariation,
      // Rule A stages. Tier 1 always goes first; tier 2 is the silent fallback; tier 3 joins it only when enabled.
      stages: s.includeTier23 ? [[1], [2, 3]] : [[1], [2]]
    };

    var built = buildEligible(database, ctx);
    var eligible = built.eligible;
    if (!eligible.length) return emptyResult('no_matches', { hidden: built.hidden });

    var seen = toSet(s.previouslyGeneratedIds);
    var need = Math.max(0, requested);

    // ---- pass 1: only exercises not generated before in this session (Rule A)
    var fresh = eligible.filter(function (c) { return !seen.has(c.ex.id); });
    var first = selectFromPool(fresh, need, ctx, keep);
    var selected = first.selected.slice();
    var blockedIds = new Set(first.blockedIds);
    var relaxedUsed = first.relaxedUsed;
    var cycleRestarted = false;

    // ---- pass 2: the unseen pool ran dry but earlier exercises are still eligible -> start a new cycle
    var hasSeenEligible = eligible.some(function (c) { return seen.has(c.ex.id); });
    if (selected.length < need && hasSeenEligible) {
      var second = selectFromPool(eligible.filter(function (c) { return seen.has(c.ex.id); }), need - selected.length, ctx, keep.concat(selected));
      if (second.selected.length) {
        selected = selected.concat(second.selected);
        cycleRestarted = true;
        second.blockedIds.forEach(function (id) { blockedIds.add(id); });
        relaxedUsed = relaxedUsed || second.relaxedUsed;
      }
    }

    // ---- Rule C
    var ordered = sortCompoundFirst(selected);

    // ---- session memory the caller should store for the next click
    var poolIds = new Set(eligible.map(function (c) { return c.ex.id; }));
    var next = new Set();
    seen.forEach(function (id) { if (!(cycleRestarted && poolIds.has(id))) next.add(id); });   // a restart forgets this pool only
    ordered.forEach(function (e) { next.add(e.id); });

    var tiers = { 1: 0, 2: 0, 3: 0 };
    ordered.forEach(function (e) { tiers[tierOf(e)]++; });

    // Exercises that were eligible but never made it in because Rule B already had their family+angle.
    var chosenIds = new Set(ordered.map(function (e) { return e.id; }));
    var blockedLeft = 0;
    blockedIds.forEach(function (id) { if (!chosenIds.has(id)) blockedLeft++; });

    var shortfall = Math.max(0, requested - ordered.length);
    var reason = shortfall ? (blockedLeft > 0 ? 'variation_limited' : 'pool_exhausted') : 'ok';

    return {
      exercises: ordered, requested: requested, shortfall: shortfall, reason: reason,
      tierBreakdown: tiers, cycleRestarted: cycleRestarted, relaxedUsed: relaxedUsed,
      nextPreviousIds: Array.from(next), hidden: built.hidden,
      eligibleCount: eligible.length, blockedByVariation: blockedLeft
    };
  }

  /* ------------------------------------------------------------------ session memory (used by the React hook and the vanilla UI) */

  /**
   * Holds `previouslyGeneratedIds` between clicks so Rule A works across many Generate presses.
   * Framework-agnostic: the React hook keeps one of these in a ref.
   */
  function createGeneratorSession(initialIds) {
    var seen = new Set(initialIds || []);
    return {
      /** Snapshot of the ids generated so far. */
      ids: function () { return Array.from(seen); },
      size: function () { return seen.size; },
      /** Generates a batch and remembers it. Same arguments as generateExercises. */
      generate: function (targetMuscle, equipment, numExercises, userSettings) {
        var result = generateExercises(targetMuscle, equipment, numExercises,
          Object.assign({}, userSettings, { previouslyGeneratedIds: seen }));
        seen = new Set(result.nextPreviousIds);
        return result;
      },
      /** Marks ids as used without generating (e.g. a swapped-out exercise). */
      remember: function (ids) { toList(ids).forEach(function (id) { seen.add(id); }); },
      /** Forgets everything; the next Generate starts again from Tier 1. */
      reset: function () { seen = new Set(); }
    };
  }

  /* ------------------------------------------------------------------ helpers for the UI */

  /** Setup values present in the database (excluding "none"), in friendly order, with labels. */
  function listSetups(database) {
    var found = new Set();
    (database || []).forEach(function (e) { var s = setupOf(e); if (s !== 'none') found.add(s); });
    var known = Object.keys(SETUP_LABELS).filter(function (k) { return found.has(k); });
    var extra = Array.from(found).filter(function (k) { return !SETUP_LABELS[k]; }).sort();
    return known.concat(extra).map(function (k) { return { id: k, label: SETUP_LABELS[k] || k.replace(/_/g, ' ') }; });
  }

  return {
    generateExercises: generateExercises,
    createGeneratorSession: createGeneratorSession,
    sortCompoundFirst: sortCompoundFirst,
    fisherYates: fisherYates,
    varietyKey: varietyKey,
    movementStem: movementStem,
    listSetups: listSetups,
    SETUP_LABELS: SETUP_LABELS,
    MAX_EXERCISES: MAX_EXERCISES
  };
});
