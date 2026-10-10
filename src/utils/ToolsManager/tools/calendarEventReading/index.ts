import { IStreamEvent } from "@/utils/AiProviders/baseOpenAILikeProvider";
import { safeJsonParse } from "@/utils/formatters";
import RNCalendarEvents, { type CalendarEventReadable } from "react-native-calendar-events";
import { ensureCalendarPermission, toCalendarCitation, type CalendarEventCitation } from "@/utils/calendar";
import moment from 'moment';
import i18n, { tKey } from "@/i18n";

/** Allowed values for the `search` parameter */
export type SearchType = 'today' | 'tomorrow' | 'this week' | 'next week' | 'this month' | 'next month' | 'specific date';

/** Status line shown while reading, per `search` value (excludes 'specific date') */
const READING_STATUS: Record<string, string> = {
    'today': tKey('tools.calendar_event_reading.status_today'),
    'tomorrow': tKey('tools.calendar_event_reading.status_tomorrow'),
    'this week': tKey('tools.calendar_event_reading.status_this_week'),
    'next week': tKey('tools.calendar_event_reading.status_next_week'),
    'this month': tKey('tools.calendar_event_reading.status_this_month'),
    'next month': tKey('tools.calendar_event_reading.status_next_month'),
};

/** Human-readable label for the current search context */
function searchLabel(search: SearchType, specificDate: string): string {
    return search === 'specific date' ? specificDate : search;
}

export default {
    id: 'calendarEventReading',
    get name() { return i18n.t('tools.calendar_event_reading.name'); },
    get description() { return i18n.t('tools.calendar_event_reading.description'); },
    defaultEnabled: false,
    category: 'appConnections',
    group: 'calendar',
    // Ask when the user turns the tool on, so a reply is never stuck behind the permission dialog.
    requestPermission: () => ensureCalendarPermission(true),
    get permissionDeniedMessage() { return i18n.t('tools.calendar_event_reading.permission_denied'); },
    definition: {
        type: 'function',
        function: {
            name: 'read_calendar_events',
            description: 'Read the calendar events for the given time range for the users',
            parameters: {
                type: 'object',
                properties: {
                    search: {
                        type: 'string',
                        description: 'The search query to filter the calendar events. Optional.',
                        enum: ['today', 'tomorrow', 'this week', 'next week', 'this month', 'next month', 'specific date'],
                    },
                    specificDate: {
                        type: 'string',
                        description: 'The specific date to search for in ISO 8601 format. Required if search is "specific date".',
                    },
                },
                required: [],
            },
        },
    },
    config: {},
    execute: async function (args: string | { search?: string; specificDate?: string }, streamEmitter: (event: IStreamEvent, data: any) => void) {
        try {
            const parsedArgs = typeof args === 'string' ? safeJsonParse(args) : args;
            const rawSearch = parsedArgs?.search ?? 'today';
            const specificDate = parsedArgs?.specificDate;

            // Validate search type
            if (!(rawSearch in READING_STATUS)) {
                return `Invalid search value "${rawSearch}". Allowed values are: today, tomorrow, this week, next week, this month, next month, specific date.`;
            }
            const search = rawSearch as SearchType;

            // Validate specificDate when required or present
            if (search === 'specific date') {
                if (!specificDate) {
                    return 'The search type is "specific date" but no specificDate was provided. Please provide a date in YYYY-MM-DD format.';
                }
                const parsed = moment(specificDate, 'YYYY-MM-DD', true);
                if (!parsed.isValid()) {
                    return `Invalid specificDate "${specificDate}". Please provide a date in YYYY-MM-DD format (e.g. 2026-10-15).`;
                }
            } else if (specificDate) {
                const parsed = moment(specificDate, 'YYYY-MM-DD', true);
                if (!parsed.isValid()) {
                    return `Ignoring unrecognized specificDate "${specificDate}" for search "${search}".`;
                }
                // For non-specific-date searches, still use the provided date as the anchor
            }

            const effectiveDate = search === 'specific date' ? specificDate! : moment().format('YYYY-MM-DD');
            const { startDate, endDate } = this._searchTypeToDate(search, effectiveDate);
            streamEmitter('report_status', search === 'specific date' || !READING_STATUS[search]
                ? i18n.t('tools.calendar_event_reading.status_date', { date: searchLabel(search, effectiveDate) })
                : i18n.t(READING_STATUS[search]));

            // Normally granted when the tool was switched on - access can be revoked in settings since.
            if (!(await ensureCalendarPermission(true))) return 'Calendar access is not granted, so the calendar could not be read. Tell the user to allow calendar access for AnythingLLM in their phone settings.';

            const events = await RNCalendarEvents.fetchAllEvents(startDate, endDate);
            if (!events?.length) return `There are no events in the user's calendar for ${searchLabel(search, effectiveDate)}.`;

            // Every event read is a source the user can open in their calendar app.
            const citations = events.map(toCalendarCitation).filter((citation): citation is CalendarEventCitation => !!citation);
            if (citations.length > 0) streamEmitter('report_citations', citations);

            // Filter all-day events that fall outside the requested day(s)
            const filteredEvents = this._filterEventsForRange(events, search, effectiveDate);

            // Build event descriptions with sort keys
            const eventEntries: Array<{ sortKey: string; isAllDay: boolean; text: string; id: string }> = [];
            for (const event of filteredEvents) {
                const { text, sortKey } = this._formatEventEntry(event, search, effectiveDate);
                eventEntries.push({ sortKey, isAllDay: !!event.allDay, text, id: String(event.id) });
            }

            // Sort: all-day first, then chronologically
            eventEntries.sort((a, b) => {
                if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
                return a.sortKey.localeCompare(b.sortKey);
            });

            if (eventEntries.length === 0) return `There are no events in the user's calendar for ${searchLabel(search, effectiveDate)}.`;

            let eventText = `You have ${eventEntries.length} event${eventEntries.length > 1 ? 's' : ''} in your calendar for ${searchLabel(search, effectiveDate)}:\n\n`;
            const body = eventEntries.map(e => `(${e.id}) ${e.text}`).join('\n---\n');
            eventText += body;
            return eventText;
        } catch (e) {
            console.error(`Calendar Event Reading Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
            return `There was an error reading the calendar.`;
        }
    },
    /** Format a single event into display text and a sort key. */
    _formatEventEntry: function (event: CalendarEventReadable, search: SearchType, effectiveDate: string): { text: string; sortKey: string } {
        if (event.allDay) {
            return this._formatAllDayEvent(event, search, effectiveDate);
        }
        return this._formatTimedEvent(event, search, effectiveDate);
    },

    /** Format an all-day event using UTC dates (avoids timezone shift). */
    _formatAllDayEvent: function (event: CalendarEventReadable, search: SearchType, effectiveDate: string): { text: string; sortKey: string } {
        // All-day events from Android are UTC midnight-to-midnight (exclusive end).
        // Use moment.utc() to avoid local timezone shifting the date.
        const startUtc = moment.utc(event.startDate);
        const endUtc = event.endDate ? moment.utc(event.endDate) : startUtc.clone().add(1, 'day');

        // The end date is exclusive, so subtract one day to get the last day of the event.
        const lastDayUtc = endUtc.clone().subtract(1, 'day');

        const startFormatted = startUtc.format('dddd, MMMM D, YYYY');
        let datePart: string;
        if (startUtc.isSame(lastDayUtc, 'day')) {
            datePart = startFormatted;
        } else {
            // Multi-day event: "Monday, Oct 13 to Wednesday, Oct 15, all day"
            const endFormatted = lastDayUtc.format('dddd, MMMM D, YYYY');
            datePart = `${startFormatted} to ${endFormatted}`;
        }

        let text = `${event.title || 'Untitled'} — ${datePart}, all day`;

        // Location (only if present)
        if (event.location) text += `, at ${event.location}`;

        // Attendees
        if (event.attendees?.length) {
            const attendeeTexts: string[] = [];
            for (const a of event.attendees) {
                if (a.name) attendeeTexts.push(`${a.name} (${a.email})`);
                else attendeeTexts.push(`${a.email}`);
            }
            text += `; attendees: ${attendeeTexts.join(', ')}`;
        }

        // Description (Android uses description, iOS uses notes)
        const desc = event.description || (event as any).notes || '';
        const formattedDesc = this._formatEventDescription(desc);
        if (formattedDesc) text += `; ${formattedDesc}`;

        // Sort key: use the start date string for ordering
        const sortKey = startUtc.format('YYYY-MM-DD');
        return { text, sortKey };
    },

    /** Format a timed event with local times. */
    _formatTimedEvent: function (event: CalendarEventReadable, search: SearchType, effectiveDate: string): { text: string; sortKey: string } {
        const startLocal = moment(event.startDate);
        const endLocal = event.endDate ? moment(event.endDate) : null;

        const startFormatted = startLocal.format('dddd, MMMM D, YYYY, h:mm A');

        // Determine if the event spans midnight (end date different from start date)
        let endFormatted: string | undefined;
        if (endLocal) {
            if (endLocal.isSame(startLocal, 'day')) {
                endFormatted = endLocal.format('h:mm A');
            } else {
                // Spans midnight: include the date for the end time
                endFormatted = endLocal.format('dddd, MMMM D, YYYY, h:mm A');
            }
        }

        // Compute duration from actual start and end times
        let durationText = '';
        if (endLocal) {
            const duration = endLocal.diff(startLocal, 'minutes');
            if (duration > 0) {
                const hours = Math.floor(duration / 60);
                const minutes = duration % 60;
                if (hours > 0 && minutes > 0) {
                    durationText = ` for ${hours} hour${hours > 1 ? 's' : ''} and ${minutes} minute${minutes > 1 ? 's' : ''}`;
                } else if (hours > 0) {
                    durationText = ` for ${hours} hour${hours > 1 ? 's' : ''}`;
                } else if (minutes > 0) {
                    durationText = ` for ${minutes} minute${minutes > 1 ? 's' : ''}`;
                }
            }
        }

        let text = `${event.title || 'Untitled'} — ${startFormatted}`;
        if (endFormatted) text += ` to ${endFormatted}`;
        text += durationText;

        // Location (only if present)
        if (event.location) text += `, at ${event.location}`;

        // Attendees
        if (event.attendees?.length) {
            const attendeeTexts: string[] = [];
            for (const a of event.attendees) {
                if (a.name) attendeeTexts.push(`${a.name} (${a.email})`);
                else attendeeTexts.push(`${a.email}`);
            }
            text += `; attendees: ${attendeeTexts.join(', ')}`;
        }

        // Description (Android uses description, iOS uses notes)
        const desc = event.description || (event as any).notes || '';
        const formattedDesc = this._formatEventDescription(desc);
        if (formattedDesc) text += `; ${formattedDesc}`;

        // Sort key: ISO date-time for chronological ordering
        const sortKey = startLocal.toISOString();
        return { text, sortKey };
    },

    /** Filter out all-day events that don't actually fall within the requested date range. */
    _filterEventsForRange: function (events: CalendarEventReadable[], search: SearchType, effectiveDate: string): CalendarEventReadable[] {
        // Build the date range
        const { startDate, endDate } = this._searchTypeToDate(search, effectiveDate);
        const rangeStart = moment(startDate);
        const rangeEnd = moment(endDate);

        // Convert to UTC for comparing against all-day event dates (stored as UTC midnight)
        const rangeStartUtc = moment.utc(rangeStart.toDate());
        const rangeEndUtc = moment.utc(rangeEnd.toDate()).subtract(1, 'second');

        return events.filter(event => {
            if (!event.allDay) return true; // Timed events are already within the fetch range

            // All-day event: check if its UTC date falls within the range
            const eventStartUtc = moment.utc(event.startDate);
            const eventEndUtc = event.endDate ? moment.utc(event.endDate).subtract(1, 'day') : eventStartUtc; // inclusive end

            return eventStartUtc.isSameOrBefore(rangeEndUtc, 'day') && eventEndUtc.isSameOrAfter(rangeStartUtc, 'day');
        });
    },

    _searchTypeToDate: function (searchType: SearchType, specificDate?: string) {
        switch (searchType) {
            case 'today':
                return {
                    startDate: moment().startOf('day').toISOString(),
                    endDate: moment().endOf('day').toISOString()
                };
            case 'tomorrow':
                return {
                    startDate: moment().add(1, 'day').startOf('day').toISOString(),
                    endDate: moment().add(1, 'day').endOf('day').toISOString()
                };
            case 'this week':
                return {
                    startDate: moment().startOf('week').toISOString(),
                    endDate: moment().endOf('week').toISOString()
                };
            case 'next week':
                return {
                    startDate: moment().add(1, 'week').startOf('week').toISOString(),
                    endDate: moment().add(1, 'week').endOf('week').toISOString()
                };
            case 'this month':
                return {
                    startDate: moment().startOf('month').toISOString(),
                    endDate: moment().endOf('month').toISOString()
                };
            case 'next month':
                return {
                    startDate: moment().add(1, 'month').startOf('month').toISOString(),
                    endDate: moment().add(1, 'month').endOf('month').toISOString()
                };
            case 'specific date': {
                const d = moment(specificDate, 'YYYY-MM-DD', true);
                if (!d.isValid()) {
                    return {
                        startDate: moment().startOf('day').toISOString(),
                        endDate: moment().endOf('day').toISOString()
                    };
                }
                return {
                    startDate: d.startOf('day').toISOString(),
                    endDate: d.endOf('day').toISOString()
                };
            }
            default:
                // Fallback to today for unknown search types
                return {
                    startDate: moment().startOf('day').toISOString(),
                    endDate: moment().endOf('day').toISOString()
                };
        }
    },
    _formatEventDescription: function (descriptionContent: string): string {
        if (!descriptionContent) return '';

        if (descriptionContent.includes('Join Zoom Meeting')) {
            const regex = /(join\s+zoom\s+meeting)/i;
            const parts = descriptionContent.split(regex);
            descriptionContent = parts[0]?.trim();
        }

        if (descriptionContent.includes('Microsoft Teams Need help?')) {
            const regex = /(microsoft\s+teams\s+need\s+help\?)/i;
            const parts = descriptionContent.split(regex);
            descriptionContent = parts[0]?.replace('_', '').trim(); // underscores are used to separate the text note from the schedule links
        }

        const keyPhrasesRegex = [
            /(need\s+to\s+make\s+changes\s+to\s+this\s+event\?)/i,
            /(this\s+is\s+a\s+google\s+meet\s+web\s+conference\.)/i,
        ];

        // Remove all the key phrases from the description content
        for (const keyPhraseRegex of keyPhrasesRegex) {
            const parts = descriptionContent.split(keyPhraseRegex);
            if (parts?.[0]) descriptionContent = parts[0]?.trim();
        }

        return descriptionContent ? `Event Description: ${descriptionContent}.` : '';
    }
} as const;