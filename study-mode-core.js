function boundedPoints(value, maximum) {
  const points = Number(value);
  return Number.isFinite(points) ? Math.max(0, Math.min(maximum, Math.round(points))) : 0;
}

/** Scores only the criteria prepared before the learner's response. Unknown or omitted IDs earn zero. */
export function scoreRubricCriteria(rubric, returned) {
  const byId = new Map((Array.isArray(returned) ? returned : []).map(item => [String(item?.id ?? ''), item]));
  return (Array.isArray(rubric) ? rubric : []).map(criterion => {
    const points = Math.max(0, Math.round(Number(criterion.points) || 0));
    const item = byId.get(String(criterion.id)) || {};
    const earned = boundedPoints(item.earned, points);
    return {
      id: String(criterion.id), name: String(criterion.name || ''), earned, available: points,
      satisfied: earned >= points && points > 0, uncertain: Boolean(item.uncertain),
      reason: String(item.reason || 'No evidence was returned for this fixed criterion.'),
      missing: String(item.missing || ''), nextTime: String(item.nextTime || ''),
    };
  });
}

/** Calculates recall score from fixed criterion weights, never from a model supplied total. */
export function scoreWeightedCriteria(criteria, returned) {
  const rubric = (Array.isArray(criteria) ? criteria : []).map(item => ({
    id: item.id, name: item.concept, points: Math.max(0, Number(item.weight) || 0),
  }));
  const scored = scoreRubricCriteria(rubric, returned).map((item, index) => ({
    id: item.id, concept: rubric[index].name, weight: rubric[index].points,
    earned: item.earned, satisfied: item.satisfied, reason: item.reason,
  }));
  const available = scored.reduce((sum, item) => sum + item.weight, 0);
  const earned = scored.reduce((sum, item) => sum + item.earned, 0);
  return { criteria: scored, earned, available, score: available ? Math.round(earned / available * 100) : 0 };
}
