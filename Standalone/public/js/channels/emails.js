/**
 * Канал кодирования через адреса электронной почты (v2 — natural email generation)
 *
 * Принцип: находим в тексте email-адреса и заменяем их на естественно выглядящие
 * закодированные email.
 *
 * Формат email: [name][surname][sep][adj][noun][number]@[domain]
 *   1. name: индекс в словаре имён      → base 1024 (10 бит)
 *   2. surname: индекс в словаре фамилий → base 512 (9 бит)
 *   3. separator: . | _ | - | +         → base 4 (2 бита)
 *   4. adj: индекс в словаре прилагательных → base 256 (8 бит)
 *   5. noun: индекс в словаре существительных → base 64 (6 бит)
 *   6. number: 0–16383                  → base 16384 (14 бит)
 *   7. domain: индекс в списке доменов   → base 16 (4 бита)
 *
 * Итого: 53 бита на email (7 позиций в mixed-radix)
 *
 * Примеры: alexivanov.coolcat@mail.ru
 *           mashapopov_darkwolf42@yandex.ru
 *           dimalebedev+superhero999@vk.com
 *
 * Все словарные записи — чисто буквенные, поэтому разделитель —
 * единственный не-алфавитный символ в local part, что обеспечивает
 * однозначный парсинг при декодировании.
 */

export class EmailsChannel {
    constructor() {
        this.name = 'emails';
        this.loaded = false;

        // Regex для поиска email в тексте
        this.EMAIL_REGEX = /[a-zA-Z0-9][a-zA-Z0-9._+\-]*@[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9][-a-zA-Z0-9.]*/g;

        // Regex для поиска телефонов — чтобы исключить коллизии
        this._phoneRegex = /(?:\+?7|8)[\s\-]*\(?\d{3}\)?[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;

        // Dictionaries (initialized by loadDictionary)
        this.NAMES = [];
        this.SURNAMES = [];
        this.ADJS = [];
        this.NOUNS = [];
        this.NUMBERS = [];
        this.DOMAINS = [];
        this.SEPARATORS = [];

        // Lookup maps for fast decoding
        this.nameMap = null;
        this.surnameMap = null;
        this.adjMap = null;
        this.nounMap = null;
        this.numMap = null;
        this.domMap = null;
        this.sepMap = null;
    }

    /**
     * Initialize dictionaries. Keeps async interface for compatibility
     * with engine.js (which awaits loadDictionary).
     */
    async loadDictionary(path) {
        this._buildDomains();
        this._buildSeparators();
        this._buildNumbers();
        this._buildNames();
        this._buildSurnames();
        this._buildAdjectives();
        this._buildNouns();

        // Build lookup maps
        this.nameMap = new Map(this.NAMES.map((v, i) => [v, i]));
        this.surnameMap = new Map(this.SURNAMES.map((v, i) => [v, i]));
        this.adjMap = new Map(this.ADJS.map((v, i) => [v, i]));
        this.nounMap = new Map(this.NOUNS.map((v, i) => [v, i]));
        this.numMap = new Map(this.NUMBERS.map((v, i) => [v, i]));
        this.domMap = new Map(this.DOMAINS.map((v, i) => [v, i]));
        this.sepMap = new Map(this.SEPARATORS.map((v, i) => [v, i]));

        this.loaded = true;
        console.log(
            `EmailsChannel: initialized — ${this.NAMES.length} names, ` +
            `${this.SURNAMES.length} surnames, ${this.ADJS.length} adjs, ` +
            `${this.NOUNS.length} nouns, ${this.DOMAINS.length} domains ` +
            `(53 bits/email)`
        );
    }

    _buildDomains() {
        this.DOMAINS = [
            'mail.ru', 'yandex.ru', 'inbox.ru', 'list.ru',
            'bk.ru', 'internet.ru', 'xmail.ru', 'ya.ru',
            'yandex.com', 'vk.com', 'lenta.ru', 'rambler.ru',
            'ro.ru', 'gazeta.ru', 'qip.ru', 'pochta.ru'
        ];
    }

    _buildSeparators() {
        this.SEPARATORS = ['.', '_', '-', '+'];
    }

    _buildNumbers() {
        this.NUMBERS = Array.from({ length: 16384 }, (_, i) => i === 0 ? '' : String(i));
    }

    _buildNames() {
        const raw = [
            "alex", "dima", "sergey", "max", "egor", "timur", "ivan", "misha", "denis", "pasha",
            "artem", "anton", "roman", "ilya", "vlad", "stas", "oleg", "zhenya", "igor", "vova",
            "grisha", "valera", "kolya", "anya", "masha", "lena", "dasha", "alina", "ira", "katya",
            "olya", "natasha", "yulia", "sveta", "vika", "ksyusha", "nastya", "polina", "vera", "nadya",
            "lyuba", "sonya", "liza", "tanya", "rita", "sasha", "lera", "kristina", "marina", "larisa",
            "zhanna", "lyuda", "galya", "alla", "john", "michael", "david", "james", "robert", "william",
            "joseph", "thomas", "charles", "daniel", "paul", "peter", "mark", "steven", "kevin", "brian",
            "bruce", "freddie", "elvis", "elton", "frank", "stevie", "phil", "johnny", "adam", "chris",
            "sarah", "emily", "jessica", "emma", "olivia", "sophia", "ava", "isabella", "mia", "amelia",
            "harper", "evelyn", "abigail", "taylor", "dua", "billie", "whitney", "mariah", "celine", "adele",
            "beyonce", "rihanna", "madonna", "tina", "britney", "kelly", "alicia", "amy", "shakira", "katy",
            "ariana", "selena", "luke", "leia", "han", "anakin", "padme", "obi", "yoda", "mando",
            "boba", "jango", "lando", "rey", "finn", "poe", "kylo", "chewy", "jack", "ryan",
            "noah", "liam", "mason", "jacob", "ethan", "logan", "jackson", "levi", "lucas", "oliver",
            "elijah", "aiden", "gabriel", "matthew", "samuel", "henry", "owen", "wyatt", "carter", "jayden",
            "dylan", "isaac", "isaiah", "julian", "josiah", "aaron", "lincoln", "mateo", "jaxon", "nathan",
            "caleb", "hunter", "christian", "landon", "jonathan", "connor", "eli", "ezra", "asher", "nolan",
            "cameron", "miles", "jace", "carson", "austin", "colton", "evan", "hudson", "bryson", "tyler",
            "jeremiah", "brayden", "jordan", "ian", "gavin", "nicolas", "greyson", "dominic", "chloe", "grace",
            "zoe", "lily", "aubrey", "lillian", "addison", "natalie", "stella", "hazel", "aurora", "violet",
            "scarlett", "savannah", "audrey", "brooklyn", "bella", "claire", "skylar", "lucy", "paisley", "everly",
            "caroline", "nova", "genesis", "emilia", "kennedy", "samantha", "maya", "willow", "kinsley", "naomi",
            "aaliyah", "elena", "allison", "gabriella", "alice", "madelyn", "cora", "ruby", "eva", "serenity",
            "autumn", "adeline", "hailey", "gianna", "valentina", "isla", "eliana", "quinn", "nevaeh", "piper",
            "jade", "sadie", "madison", "clara", "vivian", "reese", "jocelyn", "josephine", "delilah",
            // Russian diminutives
            "vasya", "petya", "borya", "slava", "fedya", "roma", "serezha", "tolya", "yura", "gleb",
            "kirill", "makar", "savva", "stepan", "filipp", "ignat", "leonid", "ruslan", "timofey", "vadim",
            "zahar", "yasha", "vitya", "senya", "arkasha", "vitalik", "edik", "marat", "rostik", "taras",
            "yan", "kamil", "ildar", "rinat", "rustam", "albert", "artur", "bogdan", "daniil", "demid",
            "emil", "german", "klim", "lev", "matvey", "miron", "nazar", "ostap", "prohor", "radmir",
            "rodion", "spartak", "yaroslav",
            // Russian female diminutives
            "zina", "klava", "tonya", "frosya", "dusya", "nyura", "lala", "zoya", "isa", "mira",
            "rina", "dina", "nina", "lada", "rada", "nona", "rosa", "sima", "toma", "ema",
            "yuna", "yara", "asya", "zara", "nika", "kira", "mika", "lita", "yasa", "vasy",
            "lolita", "milana", "zarina", "kamila", "diana", "eliza", "ella", "elvira", "emi",
            "eseniya", "ilyana", "ilona", "inessa", "inna", "karina", "karolina", "leysan", "liana",
            "liya", "marianna", "melissa", "milena", "miloslava", "miroslava", "oksana", "olesya",
            "pelageya", "radmila", "regina", "rufina", "sabina", "snezana", "tamara", "uliana",
            "ursula", "venera", "veronika", "vitalina", "vladislava", "yasmina", "yeseniya", "zlata", "zulfiya",
            // Meme / gaming / fantasy names
            "pepe", "doge", "chad", "wojak", "gigachad", "shroom", "sigma", "alpha", "beta", "gamma",
            "goblin", "troll", "shrek", "ninja", "pirate", "samurai", "knight", "king", "queen", "lord",
            "boss", "chief", "guru", "monk", "mage", "bard", "rogue", "thief", "medic", "tank",
            "healer", "dps", "sniper", "scout", "spy", "agent", "cop", "robber", "judge", "mayor",
            "celeb", "star", "idol", "fan", "hater", "simp", "nerd", "geek", "dork", "jock",
            "prep", "goth", "punk", "emo", "scene", "skater", "surfer", "biker", "racer", "pilot",
            "driver", "rider", "walker", "runner", "jumper", "flyer", "swimmer", "diver", "climber", "hiker",
            "camper", "hunter", "fisher", "farmer", "miner", "builder", "crafter", "maker", "creator", "artist",
            "writer", "poet", "singer", "dancer", "actor", "player", "gamer", "hacker", "coder", "dev",
            "tester", "admin", "mod", "user", "guest", "bot", "npc", "mob", "pet", "mount",
            "companion", "friend", "ally", "enemy", "rival", "foe", "villain", "hero", "sidekick", "mentor",
            "student", "teacher", "master", "apprentice", "slave", "servant", "guard", "warden", "prisoner", "inmate",
            "victim", "suspect", "witness", "detective", "inspector", "officer", "soldier", "warrior", "fighter", "gladiator",
            "champion", "winner", "loser", "noob", "pro", "vet", "legend", "myth", "god", "titan",
            "giant", "dwarf", "elf", "orc", "demon", "angel", "spirit", "ghost", "zombie", "vampire",
            "werewolf", "mutant", "alien", "cyborg", "robot", "droid", "clone", "synth", "mech",
            // Spanish / Latin American
            "carlos", "miguel", "javier", "diego", "pablo", "rafael", "fernando", "alberto", "julio", "manuel",
            "eduardo", "ricardo", "salvador", "ernesto", "ramon", "jorge", "sebastian", "gonzalo", "joaquin", "alejandro",
            "cristian", "nicolas", "felipe", "pedro", "raul", "bruno", "emilio", "leonardo", "thiago", "vinicius",
            "jesus", "rodrigo", "vicente", "arturo", "gustavo", "heitor", "marcelo", "nelson", "octavio", "celso",
            "fausto", "renato", "silvio", "valerio", "claudio", "damiano", "luigino", "eladio", "napoleon", "eurico",
            // Italian
            "luca", "giovanni", "alessandro", "lorenzo", "matteo", "giuseppe", "stefano", "federico", "nicola", "mario",
            "enrico", "vincenzo", "elio", "fabio", "gino", "remo", "daniele", "marcello", "antonio", "paolo",
            "aldo", "carlo", "giacomo", "maurizio", "renzo", "salvatore", "tommaso", "umberto", "vittorio", "corrado",
            // French
            "jean", "luc", "pierre", "jacques", "alain", "patrick", "philippe", "francois", "julien", "theo",
            "etienne", "olivier", "claude", "henri", "maxime", "damien", "florian", "antoine", "laurent", "didier",
            "noel", "pascal", "raymond", "roger", "sylvain", "thierry", "vincent", "gaston", "rene", "emile",
            // German
            "hans", "klaus", "wolfgang", "manfred", "heinz", "franz", "karl", "otto", "erich", "werner",
            "dieter", "hermann", "gerhard", "rainer", "matthias", "moritz", "lukas", "jonas", "niklas", "jan",
            "philipp", "simon", "benedikt", "maximilian", "leonard", "konstantin", "frederik", "tobias", "markus", "gunther",
            // Japanese (romanized)
            "kenji", "yuki", "haru", "kaito", "sota", "riku", "hiro", "takumi", "kento", "ryu",
            "jin", "sho", "akira", "ken", "daiki", "yusuke", "tatsuya", "kazuki", "hayato", "takahiro",
            "yuto", "ren", "haruki", "minoru", "naoki", "shinji", "tatsuo", "tomio", "yoshio", "kiyoshi",
            // Chinese (romanized)
            "chao", "jian", "long", "peng", "wei", "chen", "ming", "hao", "bo", "run",
            "chun", "feng", "guo", "hua", "junjie", "lirong", "qing", "sheng", "tao", "zhuo",
            // Korean
            "minjae", "hyun", "sung", "tae", "won", "soo", "chul", "dong", "ho", "seok",
            "gyu", "hyunwoo", "jaewon", "junhyuk", "kiyong", "minho", "sangwoo", "youngjae", "donghyuk", "sungho",
            // Arabic
            "omar", "hassan", "yousef", "ibrahim", "khalid", "mustafa", "hamza", "ahmad", "tariq", "zayed",
            "karim", "nasir", "salim", "walid", "bassem", "faisal", "nabil", "rafi", "yazid", "zakaria",
            // Indian
            "arjun", "neel", "anil", "sanjay", "vikram", "amit", "varun", "rajesh", "suresh", "mahesh",
            "pradeep", "deepak", "tarun", "anand", "bharat", "chetan", "dinesh", "gaurav", "hemant", "navin",
            // Scandinavian
            "erik", "lars", "sven", "bjorn", "ole", "magnus", "nils", "knut", "trygve", "harald",
            "torsten", "ragnar", "olaf", "ingvar", "leif", "dag", "sigurd", "haldor", "ulrik", "torkel",
            // Dutch
            "piet", "klaas", "willem", "hendrik", "cornelis", "maarten", "dirk", "gijs", "luuk", "stijn",
            "sem", "daan", "thijs", "jip", "wim", "kees", "joost", "bart", "dolf", "rob",
            // Polish / Czech
            "tomasz", "marek", "piotr", "slawomir", "rafal", "grzegorz", "bartosz", "pawel", "lukasz", "wojciech",
            "maciej", "jakub", "krystian", "hubert", "norbert", "radoslaw", "przemek", "milosz", "dominik", "dawid",
            // Celtic
            "declan", "finnian", "lorcan", "ciaran", "eoin", "donal", "colm", "tiarnan", "conn", "fergus",
            // African
            "kwame", "kofi", "idris", "zuri", "biko", "jadon", "kellan", "zeno", "amari", "bisa",
            // Greek
            "nikos", "dimitris", "kostas", "stavros", "christos", "panos", "alexis", "thanasis", "giannis", "spyros",
            // Turkish
            "murat", "emre", "can", "berk", "kaan", "burak", "eren", "mert", "tolga", "cem",
            // Hebrew
            "noam", "yossi", "avi", "itai", "ori", "roei", "alon", "yotam", "amir", "gideon",
            // Persian
            "arash", "sina", "babak", "kian", "roshan", "parviz", "farhad", "navid", "samad", "dara",
            // Short nicknames / diminutives
            "kai", "leo", "sam", "ben", "zac", "eli", "jax", "nox", "rex", "remy",
            "seth", "troy", "vance", "zane", "zeke", "asher", "clay", "dale", "earl", "hank",
            "neil", "ray", "wade", "cole", "dane", "glen", "knox", "lyn", "marc", "pax",
            "rhys", "slim", "tez", "vic", "wes", "abe", "ace", "baz", "buf", "cal",
            // More female names
            "sofia", "isabel", "camila", "valentina", "lucia", "paula", "laura", "sara", "marta", "carla",
            "victoria", "carmen", "ines", "blanca", "pilar", "teresa", "raquel", "lorena", "patricia", "silvia",
            "marie", "camille", "lea", "manon", "marine", "charlotte", "amelie", "colette", "denise", "blanche",
            "giulia", "chiara", "alessia", "francesca", "lucrezia", "flora", "monica", "stefania", "emilia", "simona",
            "helena", "petra", "heike", "christa", "ingrid", "gisela", "brigitte", "hanna", "ulrike", "lieselotte",
            "sakura", "hana", "mei", "rin", "aoi", "mio", "saki", "haruka", "misaki", "ayumi",
            "kaori", "nao", "riko", "hotaru", "tsuki", "yuri", "emiko", "chika", "reina", "sayuri",
            "priya", "deepa", "anita", "meena", "sunita", "kavita", "padma", "latha", "geeta", "rani",
            "astrid", "ingeborg", "greta", "hilde", "freya", "sigrid", "ranveig", "torunn", "aslaug", "tyra",
            "annika", "linnea", "ebba", "wilma", "saga", "signe", "ronja", "svea", "mirjam", "elise",
            "josefine", "almira", "bianca", "desiree", "flavia", "gianna", "iris", "liliana", "margot", "norah",
            "odette", "priscilla", "roxanne", "tessa", "ulrika", "vivianne", "willa", "xenia", "yolanda", "zelda",
            "ada", "agatha", "agnes", "anabel", "bridget", "candice", "daphne", "edith", "fiona", "gwen",
            "heather", "irma", "joan", "kenza", "mabel", "nadia", "rowena", "thea", "ursa", "vanna",
            "wendy", "xara", "yvaine", "zena"
        ];

        // Deduplicate and pad to exactly 1024
        const unique = [...new Set(raw)];
        const namePad = ["abby","addie","bobbi","cassie","danny","darcy","drew","ellie","evie","flossie",
            "frankie","gigi","hallie","hollie","jackie","jessie","joey","kellie","kennie","lacie",
            "leslie","lindsay","lizzie","lucie","mandie","mickie","minnie","missie","nellie","nicky",
            "ollie","peggie","pippa","rafe","randie","rikki","robbie","ronnie","rosie","ruthie",
            "sallie","sammie","shirley","sissie","stevie","suzie","tammy","tessie","tommie","vickie",
            "vinnie","wally","willie","winnie"];
        let npi = 0;
        while (unique.length < 1024) {
            const candidate = namePad[npi % namePad.length] + (npi >= namePad.length ? String.fromCharCode(97 + Math.floor(npi / namePad.length) % 26) : '');
            if (!unique.includes(candidate)) unique.push(candidate);
            npi++;
            if (npi > 2000) break;
        }
        this.NAMES = unique.slice(0, 1024);
    }

    _buildSurnames() {
        const raw = [
            // Top Russian surnames
            "ivanov", "smirnov", "popov", "lebedev", "kozlov", "novikov", "morozov", "petrov", "volkov", "soloviev",
            "vasiliev", "zaitsev", "pavlov", "semenov", "golubev", "vinogradov", "bogdanov", "vorobiev", "fedorov", "mikhailov",
            "belyaev", "tarasov", "belov", "komarov", "orlov", "kiselev", "makarov", "andreev", "kovalev", "ilin",
            "gusev", "titov", "kuzmin", "kudryavtsev", "baranov", "kulikov", "alekseev", "stepanov", "yakovlev", "sorokin",
            "sergeev", "romanov", "zakharov", "borisov", "korolev", "gerasimov", "ponomarev", "grigoriev", "lazarev", "medvedev",
            "ershov", "nikitin", "sobolev", "ryabov", "polyakov", "tsvetkov", "danilov", "zhukov", "frolov", "zhuravlev",
            "nikolaev", "krylov", "maksimov", "sidorov", "osipov", "belousov", "fedotov", "dorofeev", "egorov", "matveev",
            "bobrov", "dmitriev", "kalinin", "anisimov", "petukhov", "antonov", "timofeev", "nikiforov", "veselov", "filippov",
            "markov", "bolshakov", "sukhanov", "mironov", "shiryaev", "aleksandrov", "konovalov", "shevchenko", "tikhomirov", "sokolov",
            "michurin", "karpov", "vlasov", "melnikov", "denisov", "gavrilov", "tikhonov", "kazakov", "afanasev", "danilchenko",
            "saveliev", "timoshkin", "chistyakov", "kuznetsov", "malygin", "zotov", "burov", "ignatov", "rostov", "minkin",
            "krotov", "volin", "zhilin", "nosov", "titarenko",
            // Top English surnames
            "smith", "johnson", "williams", "brown", "jones", "garcia", "miller", "davis", "rodriguez", "martinez",
            "hernandez", "lopez", "gonzalez", "wilson", "anderson", "thomas", "taylor", "moore", "jackson", "martin",
            "lee", "perez", "thompson", "white", "harris", "sanchez", "clark", "ramirez", "lewis", "robinson",
            "walker", "young", "allen", "king", "wright", "scott", "torres", "nguyen", "hill", "flores",
            "green", "adams", "nelson", "baker", "hall", "rivera", "campbell", "mitchell", "carter", "roberts",
            "gomez", "phillips", "evans", "turner", "diaz", "parker", "cruz", "edwards", "collins", "reyes",
            "stewart", "morris", "morales", "murphy", "cook", "rogers", "gutierrez", "ortiz", "morgan", "cooper",
            "peterson", "bailey", "reed", "kelly", "howard", "ramos", "kim", "cox", "ward", "richardson",
            "watson", "brooks", "chavez", "wood", "james", "bennett", "gray", "mendoza", "ruiz", "hughes",
            "price", "alvarez", "castillo", "sanders", "patel", "myers", "long", "ross", "foster", "jimenez",
            // Meme / funny / gaming surnames
            "pudzh", "shlepa", "aboba", "biba", "boba", "lupa", "pupa", "dota", "csgo", "minecraft",
            "roblox", "brawl", "skuf", "masik", "chelik", "tybik", "shkolnik", "student", "zavod", "taksist",
            "kurer", "dostavka", "kassa", "ohrana", "deputat", "mer", "prezident", "car", "imperator", "bog",
            "demon", "angel", "drakon", "vampir", "oboroten", "zombi", "prizrak", "skelet", "ork", "elf",
            "gnom", "troll", "pirat", "nindzya", "rycar", "mag", "luk", "mech", "zelie", "bronya",
            "shlem", "sapogi", "perchatki", "kolco", "amulet", "artefakt", "sunduk", "klyuch", "karta", "kompas",
            "zoloto", "serebro", "bronza", "kristall", "almaz", "rubin", "sapfir", "izumrud", "zhemchug", "opal",
            "yantar", "nefrit", "agat", "oniks", "kvarc", "granit", "bazalt", "mramor", "pesok", "glina",
            "zemlya", "kamen", "skala", "gora", "vulkan", "les", "pole", "lug", "reka", "ozero",
            "more", "okean", "ostrov", "kontinent", "planeta", "zvezda", "galaktika", "vselennaya", "komos", "nebo",
            "oblako", "solnce", "luna", "veter", "dozhd", "sneg", "grad", "groza", "molniya", "grom",
            "tuman", "led", "ogon", "iskra", "plamya", "zola", "pepel", "dym", "ten", "svet",
            "zvuk", "shum", "tishina", "zapah", "vkus", "chuvstvo", "mysl", "ideya", "mechta", "fantaziya",
            "snovidenie", "koshmar", "illyuziya", "mif", "legenda", "skazka", "istoriya", "pravda", "lozh", "sekret",
            "tayna", "zagadka", "otvet",
            // More English surnames
            "murphy", "walsh", "kennedy", "donovan", "sullivan", "barrett", "byrne", "dunn", "fitzgerald", "powers",
            "higgins", "griffin", "curtis", "phelps", "shaw", "page", "hale", "burns", "walls", "tripp",
            "snow", "well", "bell", "watt", "lynn", "bass", "hart", "fate", "reed", "weed",
            // German surnames
            "weber", "mueller", "schmidt", "schneider", "fischer", "hoffmann", "braun", "zimmermann", "krause", "hartmann",
            "wagner", "becker", "schulz", "schwarz", "zimmer", "kruger", "luther", "neumann", "richter", "friedrich",
            // Italian surnames
            "rossi", "bianchi", "romano", "colombo", "ricci", "marino", "greco", "fontana", "conti", "esposito",
            "russo", "ferrari", "gallo", "costa", "giordano", "mancini", "rizzo", "lombardi", "moretti", "barbieri",
            // French surnames
            "dubois", "moreau", "laurent", "leroy", "roux", "bertrand", "morel", "fournier", "girard", "bonnet",
            "dupont", "lambert", "fontaine", "roussel", "muller", "lefebvre", "faure", "andre", "mercier", "blanc",
            // Japanese surnames
            "suzuki", "takahashi", "watanabe", "ito", "yamamoto", "nakamura", "kobayashi", "yoshida", "yamada", "sato",
            // Scandinavian surnames
            "larsson", "eriksson", "nilsson", "persson", "olsson", "lundberg", "bergstrom", "nyman", "bergman", "ahlberg",
            // Spanish surnames
            "ruiz", "jimenez", "diaz", "moreno", "alvarez", "romero", "gutierrez", "navarro", "herrera", "medina",
            "castro", "aguilar", "valdez", "delgado", "vargas", "santos", "velazquez", "mendoza", "vega", "rios",
            // Korean surnames
            "choi", "jung", "kang", "cho", "yoon", "jang", "lim", "han", "song", "yoon",
            // Polish surnames
            "nowak", "wisniewski", "kaminski", "zielinski", "szymanski", "wozniak", "kozlowski", "kaczmarek", "mazur", "jaworski",
            // Czech surnames
            "novak", "kriz", "mares", "petr", "horak", "vlcek", "kucera", "vesely", "prochazka", "benes",
            // Short nature surnames
            "moor", "nook", "pike", "thorn", "weir", "firth", "leigh", "port", "vale", "cliff",
            "grove", "ridge", "creek", "delta", "beach", "coast", "bluff", "plain", "marsh", "field"
        ];

        // Deduplicate and pad to exactly 512
        const unique = [...new Set(raw)];
        const surnamePad = ["sadowski","santos","savage","sayed","schafer","schofield","schroeder","schultz","seaman","seaton",
            "segura","selby","shepard","sherman","shields","short","siegel","sigler","silva","simmons",
            "simpson","singer","singleton","skinner","slade","small","smart","smiley","snyder","solis",
            "solomon","soto","souza","spence","spicer","spooner","spring","stacy","stafford","stanton",
            "stark","steele","steiner","stephens","stevens","stinson","stokes","stout","strange","stuart",
            "sutton","swain","swanson","sweeney","sweet"];
        let spi = 0;
        while (unique.length < 512) {
            const candidate = surnamePad[spi % surnamePad.length] + (spi >= surnamePad.length ? String.fromCharCode(97 + Math.floor(spi / surnamePad.length) % 26) : '');
            if (!unique.includes(candidate)) unique.push(candidate);
            spi++;
            if (spi > 1000) break;
        }
        this.SURNAMES = unique.slice(0, 512);
    }

    _buildAdjectives() {
        const raw = [
            "cool", "super", "mega", "pro", "dark", "light", "sweet", "crazy", "cyber", "neon",
            "silver", "gold", "black", "white", "red", "blue", "green", "yellow", "pink", "purple",
            "orange", "grey", "happy", "sad", "angry", "fast", "slow", "hard", "soft", "loud",
            "quiet", "smart", "dumb", "good", "bad", "hot", "cold", "warm", "chill", "wild",
            "tame", "brave", "weak", "strong", "rich", "poor", "old", "new", "young", "free",
            "lost", "found", "hidden", "secret", "magic", "mystic", "epic", "legend", "myth",
            "real", "fake", "true", "false", "pure", "dead", "alive", "bold", "shy", "proud",
            "humble", "fair", "foul", "clean", "dirty", "sharp", "dull", "high", "low", "big",
            "small", "huge", "tiny", "fat", "thin", "thick", "flat", "round", "square", "wide",
            "narrow", "long", "short", "rough", "smooth", "wet", "dry", "solid", "fluid", "gas",
            "plasma", "frozen", "melted", "burning", "glowing", "shiny", "bright", "dim", "clear", "blurry",
            "vivid", "pale", "heavy", "dense", "sparse", "full", "empty", "open", "closed", "locked",
            "loose", "tight", "firm", "mad", "sane", "calm", "fierce", "gentle", "cruel", "kind",
            "mean", "nice", "naughty", "lucky", "fun", "bored", "busy", "idle", "lazy", "active",
            "quick", "brisk", "swift", "rapid", "fleet", "tardy", "late", "early", "first", "last",
            "next", "prev", "past", "future", "now", "then", "soon", "near", "far", "close",
            "distant", "local", "global", "alien", "native", "foreign", "home", "away", "left", "right",
            "up", "down", "top", "bottom", "front", "back", "side", "center", "middle", "edge",
            "corner", "part", "whole", "some", "many", "few", "all", "none", "each", "every",
            "any", "murky", "silent", "noisy", "still", "moving", "static", "dynamic", "fixed", "rigid",
            "flexible", "elastic", "plastic", "metal", "wood", "stone", "glass", "paper", "cloth", "silk",
            "cotton", "wool", "leather", "fur", "bone", "flesh", "blood", "iron", "steel", "bronze",
            "brass", "copper", "lead", "zinc", "tin", "ruby", "topaz", "jade", "opal", "pearl",
            "coral", "amber", "quartz", "flint", "chalk", "sand", "dust", "dirt", "mud", "clay",
            "rock", "soil", "ash",
            // Additional descriptive adjectives
            "dazzling", "eager", "flaky", "grumpy", "hasty", "jazzy", "limp", "moist", "nimble", "plump",
            "quirky", "rusty", "salty", "tangy", "whiny", "zesty", "bland", "crude", "dizzy", "eerie",
            "fancy", "gaudy", "ironic", "jaunty", "kooky", "loopy", "mellow", "nifty", "ornate", "peppy",
            "rowdy", "snazzy", "tidy", "uneven", "vibrant", "wobbly", "yummy", "zippy"
        ];

        // Deduplicate and pad to exactly 256
        const unique = [...new Set(raw)];
        const adjPad = ["abrupt","aching","acidic","adept","adorable","agile","allied","arid","astute","blissful",
            "bouncy","brisk","candid","cheery","chunky","clunky","comfy","cranky","cuddly","dapper",
            "dainty","ditzy","dreamy","dusky","elfin","frisky","frosty","fuzzy","giddy","glum",
            "goofy","graceful","greasy","handy","hazy","jolly","juicy","klutzy","leafy","lumpy",
            "misty","peachy","plucky","poky","posh","sleek","spongy","steamy","stubby","sturdy",
            "sulky","sunny","testy","tricky","tweedy","velvety","wimpy"];
        let api = 0;
        while (unique.length < 256) {
            const candidate = adjPad[api % adjPad.length] + (api >= adjPad.length ? String.fromCharCode(97 + Math.floor(api / adjPad.length) % 26) : '');
            if (!unique.includes(candidate)) unique.push(candidate);
            api++;
            if (api > 500) break;
        }
        this.ADJS = unique.slice(0, 256);
    }

    _buildNouns() {
        const raw = [
            "cat", "dog", "wolf", "bear", "lion", "tiger", "fox", "bird", "hawk", "eagle",
            "fish", "shark", "boy", "girl", "man", "woman", "dude", "bro", "ninja", "jedi",
            "hero", "star", "moon", "sun", "sky", "sea", "fire", "ice", "stone", "rock",
            "tree", "wood", "leaf", "flower", "rose", "lily", "weed", "seed", "root", "branch",
            "stem", "fruit", "apple", "plum", "peach", "pear", "cake", "pie", "tart", "bread",
            "loaf", "bun", "roll", "soup", "stew", "meat", "beef", "pork", "lamb", "veal",
            "milk", "cheese", "butter", "cream",
            // Additional animal/nature nouns
            "crow", "deer", "dove", "moth", "toad", "wren", "ape", "eel", "ram", "newt",
            "owl", "ant", "bee", "elk", "cod", "hen", "pig", "colt", "foal", "calf"
        ];

        // Deduplicate and pad to exactly 64
        const unique = [...new Set(raw)];
        const nounPad = ["crane","heron","lark","fawn","pup","kit","cygnet","leveret","fry","pullet",
            "gosling","squab","shoat","lambkin","kidling","eyas","hatchling","nymph","caterpillar","pupa"];
        let npii = 0;
        while (unique.length < 64) {
            const candidate = nounPad[npii % nounPad.length] + (npii >= nounPad.length ? String.fromCharCode(97 + Math.floor(npii / nounPad.length) % 26) : '');
            if (!unique.includes(candidate)) unique.push(candidate);
            npii++;
            if (npii > 200) break;
        }
        this.NOUNS = unique.slice(0, 64);
    }

    /**
     * Найти все email-адреса в тексте, ИСКЛЮЧАЯ совпадения внутри телефонов.
     */
    _findEmails(text) {
        const phoneSpans = [];
        this._phoneRegex.lastIndex = 0;
        let m;
        while ((m = this._phoneRegex.exec(text)) !== null) {
            phoneSpans.push({ start: m.index, end: m.index + m[0].length });
        }

        const matches = [];
        this.EMAIL_REGEX.lastIndex = 0;
        while ((m = this.EMAIL_REGEX.exec(text)) !== null) {
            const emailStart = m.index;
            const emailEnd = m.index + m[0].length;

            const overlaps = phoneSpans.some(ps =>
                (emailStart >= ps.start && emailStart < ps.end) ||
                (emailEnd > ps.start && emailEnd <= ps.end) ||
                (emailStart <= ps.start && emailEnd >= ps.end)
            );
            if (overlaps) continue;

            matches.push({
                index: m.index,
                full: m[0],
                length: m[0].length
            });
        }
        return matches;
    }

    /**
     * Собрать email из 7 индексов.
     * Формат: [name][surname][sep][adj][noun][number]@[domain]
     */
    _buildEmail(nIdx, sIdx, sepIdx, aIdx, nnIdx, numIdx, domIdx) {
        return (
            this.NAMES[nIdx] +
            this.SURNAMES[sIdx] +
            this.SEPARATORS[sepIdx] +
            this.ADJS[aIdx] +
            this.NOUNS[nnIdx] +
            this.NUMBERS[numIdx] +
            '@' +
            this.DOMAINS[domIdx]
        );
    }

    /**
     * Разобрать email на 7 индексов.
     *
     * Поскольку все словарные записи — чисто буквенные, разделитель —
     * единственный не-алфавитный символ в local part.
     *
     * Возвращает { nIdx, sIdx, sepIdx, aIdx, nnIdx, num, domIdx } или null.
     */
    _parseEmail(emailStr) {
        const atIdx = emailStr.indexOf('@');
        if (atIdx < 0) return null;

        const localPart = emailStr.slice(0, atIdx);
        const domainPart = emailStr.slice(atIdx + 1);

        // 1. Проверяем домен
        const domIdx = this.domMap.get(domainPart.toLowerCase());
        if (domIdx === undefined) return null;

        // 2. Находим разделитель — первый не-алфавитный символ в local part
        //    (все словарные записи — чисто буквенные, поэтому разделитель
        //    выделяется однозначно)
        let sepPos = -1;
        let sepChar = '';
        for (let i = 0; i < localPart.length; i++) {
            const ch = localPart[i];
            if (this.sepMap.has(ch)) {
                sepPos = i;
                sepChar = ch;
                break;
            }
        }
        if (sepPos < 1 || sepPos >= localPart.length - 1) return null;

        const sepIdx = this.sepMap.get(sepChar);
        const left = localPart.slice(0, sepPos).toLowerCase();
        const right = localPart.slice(sepPos + 1).toLowerCase();

        // 3. Парсим left = name + surname
        //    Ищем имя-префикс, остаток должен быть в словаре фамилий
        let nIdx = -1, sIdx = -1;
        for (let i = 0; i < this.NAMES.length; i++) {
            const name = this.NAMES[i];
            if (left.startsWith(name) && left.length > name.length) {
                const surnameCandidate = left.substring(name.length);
                const s = this.surnameMap.get(surnameCandidate);
                if (s !== undefined) {
                    nIdx = i;
                    sIdx = s;
                    break;
                }
            }
        }
        if (nIdx < 0) return null;

        // 4. Парсим right = adj + noun + number
        //    Сначала извлекаем trailing digits (число)
        const numMatch = right.match(/(\d+)$/);
        let numStr = '';
        let adjNounStr = right;
        if (numMatch && numMatch.index > 0) {
            numStr = numMatch[1];
            adjNounStr = right.slice(0, -numStr.length);
        }

        const num = this.numMap.get(numStr);
        if (num === undefined) return null;

        // Ищем прилагательное-префикс, остаток должен быть в словаре существительных
        let aIdx = -1, nnIdx = -1;
        for (let i = 0; i < this.ADJS.length; i++) {
            const adj = this.ADJS[i];
            if (adjNounStr.startsWith(adj) && adjNounStr.length > adj.length) {
                const nounCandidate = adjNounStr.substring(adj.length);
                const n = this.nounMap.get(nounCandidate);
                if (n !== undefined) {
                    aIdx = i;
                    nnIdx = n;
                    break;
                }
            }
        }
        if (aIdx < 0) return null;

        return { nIdx, sIdx, sepIdx, aIdx, nnIdx, num, domIdx };
    }

    analyzeCapacity(text) {
        if (!this.loaded) return { totalBits: 0, positions: [], bases: [] };

        const emails = this._findEmails(text);
        if (emails.length === 0) return { totalBits: 0, positions: [], bases: [] };

        const positions = [];
        const bases = [];

        for (const email of emails) {
            positions.push({ index: email.index, length: email.length, type: 'email' });
            // 7 позиций на email: name(1024) + surname(512) + sep(4) + adj(256) + noun(64) + num(16384) + dom(16)
            bases.push(1024, 512, 4, 256, 64, 16384, 16);
        }

        const totalBits = bases.reduce((sum, b) => sum + Math.log2(b), 0);
        return { totalBits, positions, bases };
    }

    encode(text, indices) {
        if (!this.loaded || indices.length === 0) return text;

        const emails = this._findEmails(text);
        if (emails.length === 0) return text;

        const POS_PER_EMAIL = 7;
        const replacements = [];
        let idx = 0;

        for (const email of emails) {
            if (idx + POS_PER_EMAIL > indices.length) break;

            const nIdx   = indices[idx]     % 1024;
            const sIdx   = indices[idx + 1] % 512;
            const sepIdx = indices[idx + 2] % 4;
            const aIdx   = indices[idx + 3] % 256;
            const nnIdx  = indices[idx + 4] % 64;
            const numIdx = indices[idx + 5] % 16384;
            const domIdx = indices[idx + 6] % 16;

            const newEmail = this._buildEmail(nIdx, sIdx, sepIdx, aIdx, nnIdx, numIdx, domIdx);
            replacements.push({
                index: email.index,
                length: email.length,
                replacement: newEmail
            });

            idx += POS_PER_EMAIL;
        }

        // Apply in reverse order
        let result = text;
        for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            result = result.slice(0, r.index) + r.replacement + result.slice(r.index + r.length);
        }

        return result;
    }

    decode(stegoText) {
        if (!this.loaded) return [];

        const emails = this._findEmails(stegoText);
        const indices = [];

        for (const email of emails) {
            const p = this._parseEmail(email.full);
            if (!p) continue;

            indices.push(p.nIdx, p.sIdx, p.sepIdx, p.aIdx, p.nnIdx, p.num, p.domIdx);
        }

        return indices;
    }

    getStats() {
        return {
            name: this.name,
            loaded: this.loaded,
            names: this.NAMES.length,
            surnames: this.SURNAMES.length,
            adjectives: this.ADJS.length,
            nouns: this.NOUNS.length,
            domains: this.DOMAINS.length,
            positionsPerEmail: 7,
            bitsPerEmail: 53,
        };
    }
}

export default EmailsChannel;
