import { RepetitionItem } from "src/dataStore/repetitionItem";
import { DateUtils, debug } from "src/util/utils_recall";

export function postponeItems(
    items: RepetitionItem[],
    cnt?: number,
    days?: number,
): RepetitionItem[] {
    const now = Date.now();
    const newdue: number = days ? now + days * DateUtils.DAYS_TO_MILLIS : undefined;
    const fltItems = items
        .filter((item) => item.isTracked && item.nextReview < DateUtils.StartofToday)
        .sort((a, b) => currentRetention(a) - currentRetention(b))
        // https://github.com/open-spaced-repetition/fsrs4anki-helper/blob/58bcfcf8b5eeb60835c5cbde1d0d0ef769af62b0/schedule/postpone.py#L73
        .filter((item) => {
            // currentR>0.65
            // const rate = (1 / currentRetention(item) - 1) / (1 / 0.9 - 1) - 1;
            // const rate = currentRetention(item) / 0.9 - 1;
            console.debug("current R:", currentRetention(item), 1 / currentRetention(item) - 1);
            return currentRetention(item) > 0.65;
        });
    const safe_cnt = fltItems.length;
    debug("postpone", 0, { safe_cnt });
    postpone(fltItems, newdue);
    return items;
}

function elapsed_days(item: RepetitionItem) {
    const delay = (Date.now() - item.nextReview) / DateUtils.DAYS_TO_MILLIS;
    return item.interval + delay;
}
function currentRetention(item: RepetitionItem) {
    // from fsrs.js repeat retrievability
    return Math.pow(1 + elapsed_days(item) / (9 * item.interval), -1);
}

function postpone(items: RepetitionItem[], newdue?: number): RepetitionItem[] {
    let cnt = 0;
    items.map((item) => {
        let newitvl: number,
            olastview = item.hasDue ? item.nextReview - item.interval*DateUtils.DAYS_TO_MILLIS : Date.now();

        // reschedule, request Retention=0.9
        // let interval = item.interval * 9 * (1 / 0.9 - 1);
        // newitvl = Math.min(Math.max(Math.round(interval), 1), 3650);

        const delay = (Date.now() - olastview) / DateUtils.DAYS_TO_MILLIS - item.interval;
        newitvl = Math.min(
            Math.max(1, Math.ceil(item.interval * (1.05 + 0.05 * Math.random())) + delay),
            36500,
        );
        // newdue = newdue ? newdue : Date.now() + newitvl * DateUtils.DAYS_TO_MILLIS;
        if (newitvl !== item.interval) {
            cnt++;
            item.updateDueInterval(newitvl, newdue);
        }
    });
    debug("postpone", 0, { cnt });
    return items;
}
