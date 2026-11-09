// How anki-scheduler.json was made, kept for reference. It ran as a test
// inside the Rust backend at commit d334c91 (src-tauri/src/srs.rs, the Rust
// port of Anki's scheduler using the same `rand` 0.10.1 StdRng as Anki):
//
//   FIXTURE_OUT=anki-scheduler.json cargo test fixture -- --ignored
//
// The Node scheduler and RNG are checked against its output in
// test/srs.test.ts.

//! Generates reference outputs from the Rust (Anki-derived) scheduler for the
//! Node port to be checked against.
use crate::srs::{self, Context, Grade, Schedule, State};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rand::prelude::*;
use rand::rngs::StdRng;

fn base() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-03-10T04:00:00Z").unwrap().with_timezone(&Utc)
}
fn rollover(n: i64) -> DateTime<Utc> {
    base() + Duration::days(n)
}
fn ts(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[test]
#[ignore]
fn write_fixture() {
    let mut gen = StdRng::seed_from_u64(42);
    let mut rng_cases = Vec::new();
    for i in 0..100u64 {
        let seed: u64 = if i < 50 { i } else { gen.random::<u64>() };
        let factor: f32 = StdRng::seed_from_u64(seed).random_range(0.0..1.0);
        let secs: u32 = [60, 330, 600, 900, 3600, 7, 1][(i % 7) as usize];
        let upper = secs + ((secs as f32) * 0.25).min(300.0).floor() as u32;
        let learn = if secs >= upper { secs } else { StdRng::seed_from_u64(seed).random_range(secs..upper) };
        let mut words = Vec::new();
        let mut r = StdRng::seed_from_u64(seed);
        for _ in 0..20 { words.push(r.next_u32()); }
        rng_cases.push(serde_json::json!({
            "seed": seed.to_string(), "factorBits": factor.to_bits(), "secs": secs,
            "learn": learn, "words": words,
        }));
    }

    let states = [State::New, State::Learning, State::Review, State::Relearning];
    let grades = [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy];
    let mut cases = Vec::new();
    for i in 0..1000u32 {
        let state = states[gen.random_range(0..4)];
        let grade = grades[gen.random_range(0..4)];
        let interval: f64 = match gen.random_range(0..5) {
            0 => 0.0,
            1 => gen.random_range(1..10) as f64,
            2 => gen.random_range(1..400) as f64,
            3 => (gen.random_range(10..4000) as f64) / 10.0,
            _ => gen.random_range(30000..37000) as f64,
        };
        let ease = (gen.random_range(1300..3600) as f64) / 1000.0
            + if gen.random_bool(0.1) { 0.0004 } else { 0.0 };
        let step = gen.random_range(0..3) as i64;
        let reps = gen.random_range(0..60) as i64;
        let lapses = gen.random_range(0..10) as i64;
        let card_id: i64 = if gen.random_bool(0.5) { gen.random_range(1..5000) } else { gen.random_range(1_600_000_000_000i64..1_800_000_000_000) };
        let days_since_due = gen.random_range(-40..40) as i64;
        let now = base() + Duration::seconds(gen.random_range(0..86_400));
        let fuzz = gen.random_bool(0.8);
        let prev = Schedule { state, step, interval_days: interval, ease, reps, lapses, due_at: now };
        let ctx = Context {
            now,
            day_start: &rollover,
            days_since_due,
            fuzz_seed: if fuzz { Some(srs::fuzz_seed(card_id, reps)) } else { None },
        };
        let next = srs::review(prev, grade, &ctx);
        cases.push(serde_json::json!({
            "i": i,
            "input": { "state": state.as_str(), "step": step, "intervalDays": interval, "ease": ease,
                       "reps": reps, "lapses": lapses, "cardId": card_id, "daysSinceDue": days_since_due,
                       "now": ts(now), "fuzz": fuzz, "grade": grade.as_i64() },
            "output": { "state": next.state.as_str(), "step": next.step, "intervalDays": next.interval_days,
                        "ease": next.ease, "reps": next.reps, "lapses": next.lapses, "dueAt": ts(next.due_at) },
        }));
    }
    let out = serde_json::json!({ "rollover0": ts(rollover(0)), "rng": rng_cases, "review": cases });
    std::fs::write(std::env::var("FIXTURE_OUT").unwrap(), serde_json::to_string(&out).unwrap()).unwrap();
}
