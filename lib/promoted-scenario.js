// The sessionStorage key /scenarios/generate writes a promoted candidate to
// and /scenarios/new reads it back from.
//
// It lives in its own module because a Next App Router page.js may only
// export the component and Next's own route config, so neither page can
// export it to the other — and duplicating the literal makes a typo fail
// SILENTLY: the write and the navigation both succeed, the read finds
// nothing, and the user lands on an empty form with no error anywhere and no
// clue the candidate they paid for is gone.
//
// Imports nothing, like lib/judge-dimensions.js and lib/seed-presets.js, so a
// client component can pull it in without dragging lib/supabase.js (and the
// Supabase SDK) into the browser bundle.
export const PROMOTED_SCENARIO_KEY = "generatedScenario";
