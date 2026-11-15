// Node takes navigator.language from the system: the unit tests read the IDE in English, as the
// e2e tests do, whatever the language of the PC that runs them.
import { setLanguage } from '../../src/i18n/tr.ts';

setLanguage('en');
