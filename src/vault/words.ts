/**
 * Words that never become link targets on their own. A note titled "Time" or "Inbox" would
 * otherwise link half of every highlight. Concept words people actually title notes with
 * (trust, money, power, leadership…) are deliberately absent: those notes should link.
 */
export const COMMON_WORDS = new Set(
  (
    // frequent function words and verbs
    "about above across actually after again against almost alone along already also although always among " +
    "another anyone anything anyway appear around away became because become becomes been before began begin " +
    "behind being believe below beside besides best better between beyond both bring brought came cannot could " +
    "didn't does doesn't doing done down during each either else enough even ever every everyone everything " +
    "except felt find first from gave get gets getting give given gives goes going gone good got great have " +
    "having here herself himself however into itself just keep kept kind knew know known knows last later least " +
    "left less like likely little made make makes making many maybe mean means meant might more most mostly much " +
    "must myself near nearly need needs neither never next none nothing often once only onto other others " +
    "otherwise ourselves over perhaps quite rather real really same seem seemed seems seen several shall should " +
    "shown since some someone something sometimes somewhere soon still such sure take taken takes than that " +
    "their theirs them themselves then there therefore these they thing things think this those though thought " +
    "through thus today together told took toward towards true under unless until upon used uses using very " +
    "want wants was well went were what whatever when whenever where whether which while whole whom whose will " +
    "with within without would yeah year years your yours yourself yourselves " +
    // very frequent generic nouns and adjectives
    "able area areas back case cases come comes different early easy example fact facts few form full half " +
    "hand hands high important kinds large late level line lines long look looking lot lots main matter number " +
    "numbers part parts place places point points possible problem problems question questions reason reasons " +
    "right says second small sort sorts start state states side sides time times turn turns type types " +
    "used way ways week weeks work works world young " +
    // note-taking structure: folders and scaffolding notes, not topics
    "archive archives assets attachments book books chapter chapters daily draft drafts home idea ideas inbox " +
    "index journal location meeting meetings misc monthly note notes page pages people project projects readme " +
    "reading resources scratch task tasks template templates todo todos untitled weekly yearly " +
    // days and months
    "monday tuesday wednesday thursday friday saturday sunday january february march april june july august " +
    "september october november december"
  ).split(/\s+/),
);

/** A multi-word title made only of these ("To Do", "The End") is not a link target either. */
export const FUNCTION_WORDS = new Set(
  (
    "a an the to do does did done of in on at by for with and or but not no yes is are was were be been am it " +
    "its this that these those as so if up out off end all my me we you your our he she they them i what when " +
    "where how why who which there here then than too very can will just one two new go get"
  ).split(/\s+/),
);
