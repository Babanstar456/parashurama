// Hindi / English switch for the parts a soldier reads first: the home menus, the first-target coach, the gun-drill
// debrief and the field guide. t(english, vars) returns the Hindi text when Hindi is chosen; anything not in the table
// stays in English. Weapon and drone names, keys, FIRE / HOLD FIRE and doctrine rule codes stay in English on purpose
// (that is how they are used on the gun line). The Hindi wording is a first draft for review by the unit.
const KEY = 'parashurama.lang';
export type Lang = 'en' | 'hi';
export let lang: Lang = (() => { try { return localStorage.getItem(KEY) === 'hi' ? 'hi' : 'en'; } catch { return 'en'; } })();
const subs: (() => void)[] = [];
export function onLang(f: () => void) { subs.push(f); }
export function setLang(l: Lang) {
  lang = l; try { localStorage.setItem(KEY, l); } catch { /* storage blocked */ }
  document.documentElement.lang = l === 'hi' ? 'hi' : 'en'; subs.forEach((f) => f());
}
export function t(s: string, v?: Record<string, string | number>): string {
  let o = lang === 'hi' ? HI[s] ?? s : s;
  if (v) for (const k of Object.keys(v)) o = o.split(`{${k}}`).join(String(v[k]));
  return o;
}
if (typeof document !== 'undefined') document.documentElement.lang = lang === 'hi' ? 'hi' : 'en';

const HI: Record<string, string> = {
  // Language switch
  'हिंदी': 'English',
  // Home: play screen
  'Train every soldier to stop hostile drones.': 'हर सैनिक को दुश्मन ड्रोन रोकना सिखाएँ।',
  'On any laptop. Even offline.': 'किसी भी लैपटॉप पर। बिना इंटरनेट के भी।',
  'MULTIPLAYER': 'मल्टीप्लेयर',
  'Crew drills over your unit network · push-to-talk radio': 'यूनिट नेटवर्क पर क्रू ड्रिल · पुश-टू-टॉक रेडियो',
  'Play': 'खेलें', 'Learn': 'सीखें',
  'or watch the 90-second demo': 'या 90 सेकंड का डेमो देखें',
  'Training values only, not equipment specifications': 'केवल प्रशिक्षण मान, उपकरण विनिर्देश नहीं',
  // Home: cards and navigation
  'Start here': 'यहाँ से शुरू करें', 'Done ✓': 'पूरा ✓', 'Start →': 'शुरू करें →', '← Back': '← वापस',
  'On Ground': 'ऑन ग्राउंड', 'Radar': 'रडार', 'Real-world missions': 'वास्तविक मिशन',
  'Where do you train?': 'आप कहाँ प्रशिक्षण लेंगे?',
  'Pick one. You can come back and try the other at any time.': 'एक चुनें। आप कभी भी लौटकर दूसरा आज़मा सकते हैं।',
  'Guns': 'गन', 'Screen': 'स्क्रीन',
  'Sit at the gun: L-70, Shilka or ZU-23-2. Spot the drone in the sky, identify it and fire. You can also drive the Shilka through a town.': 'गन पर बैठें: L-70, शिल्का या ZU-23-2। आसमान में ड्रोन देखें, पहचानें और फ़ायर करें। आप शिल्का को एक शहर में चला भी सकते हैं।',
  'Choose a gun →': 'गन चुनें →',
  'Work the radar screen: spot drones, decide friend or foe, and pick the right way to stop each one. Lessons with a coach first.': 'रडार स्क्रीन संभालें: ड्रोन पकड़ें, दोस्त या दुश्मन तय करें, और हर एक को रोकने का सही तरीका चुनें। पहले कोच के साथ पाठ।',
  'Choose →': 'चुनें →',
  'For commanders and instructors:': 'कमांडरों और प्रशिक्षकों के लिए:', 'Unit readiness': 'यूनिट तत्परता',
  '(you: {a} of {b} skills certified)': '(आप: {b} में से {a} कौशल प्रमाणित)', 'Classroom library': 'कक्षा पुस्तकालय',
  'Choose a gun': 'गन चुनें',
  'Start with an easy one: day, clear sky, sensors working. Each drill takes a few minutes, and every decision is explained at the end.': 'आसान से शुरू करें: दिन, साफ़ आसमान, सेंसर चालू। हर ड्रिल कुछ मिनट की है, और अंत में हर फ़ैसला समझाया जाता है।',
  'Easy': 'आसान', 'Medium': 'मध्यम', 'Hard': 'कठिन',
  'L-70 gun': 'L-70 गन',
  'The thermal sight and laser rangefinder track the drone and work out the lead for you.': 'थर्मल साइट और लेज़र रेंजफ़ाइंडर ड्रोन को ट्रैक करते हैं और आपके लिए लीड निकालते हैं।',
  'Shilka (ZSU-23-4)': 'शिल्का (ZSU-23-4)',
  'The radar locks on and shows you where to aim (the lead). You report, identify and fire.': 'रडार लॉक करता है और बताता है कि कहाँ निशाना लगाना है (लीड)। आप रिपोर्ट करें, पहचानें और फ़ायर करें।',
  'Urban patrol': 'शहरी गश्त',
  'Drive the Shilka through an old town. Drones pop up over the rooftops: engage only hostiles.': 'शिल्का को एक पुराने शहर से चलाएँ। ड्रोन छतों के ऊपर से अचानक आते हैं: केवल दुश्मन पर फ़ायर करें।',
  'Saturation raid': 'सैचुरेशन हमला',
  '14 Shahed-type drones in waves. The outer layer stops some; you take the leakers, closest first, before they reach you.': 'लहरों में 14 शाहेद-प्रकार के ड्रोन। बाहरी परत कुछ को रोकती है; बचे हुए आप रोकें, सबसे नज़दीकी पहले, इससे पहले कि वे आप तक पहुँचें।',
  'ZU-23-2 (upgraded)': 'ZU-23-2 (उन्नत)',
  'The upgraded twin gun: day camera, thermal imager, laser rangefinder and a digital fire-control computer. Old manual sight under More gun drills.': 'उन्नत जुड़वाँ गन: डे कैमरा, थर्मल इमेजर, लेज़र रेंजफ़ाइंडर और डिजिटल फ़ायर-कंट्रोल कंप्यूटर। पुरानी मैनुअल साइट "और गन ड्रिल" में।',
  'More gun drills': 'और गन ड्रिल',
  ': crew the gun on orders, run the control room, reload practice, UAV strike.': ': आदेश पर गन चलाएँ, कंट्रोल रूम संभालें, रीलोड अभ्यास, UAV स्ट्राइक।',
  'Last score {n} · Start →': 'पिछला स्कोर {n} · शुरू करें →',
  'Radar training': 'रडार प्रशिक्षण',
  'New to it? Start with the lessons: a coach explains every clue and when not to fire.': 'नए हैं? पाठों से शुरू करें: कोच हर संकेत समझाता है और बताता है कब फ़ायर नहीं करना।',
  '{a} of {b} lessons': '{b} में से {a} पाठ', 'Learn with a coach': 'कोच के साथ सीखें',
  'Four short lessons, about 10 minutes in all. Next: {t}.': 'चार छोटे पाठ, कुल लगभग 10 मिनट। अगला: {t}।',
  'All lessons done. Replay any lesson.': 'सभी पाठ पूरे। कोई भी पाठ दोबारा करें।',
  'Start lesson {n} →': 'पाठ {n} शुरू करें →', 'Replay →': 'दोबारा →',
  '3 minutes': '3 मिनट', 'Recognition trainer': 'पहचान प्रशिक्षक',
  'Name the drone in 1.5 seconds: by eye, binoculars, TV or thermal, day and night. The types you mix up come back more often.': '1.5 सेकंड में ड्रोन का नाम बताएँ: आँख, दूरबीन, TV या थर्मल से, दिन और रात। जिन प्रकारों में आप गलती करते हैं वे ज़्यादा बार आते हैं।',
  'Scored': 'स्कोर वाला', 'Quick radar drill': 'त्वरित रडार ड्रिल',
  'A short drill the enemy AI builds around your weakest skill: <strong>{w}</strong>.': 'दुश्मन AI आपकी सबसे कमज़ोर क्षमता पर एक छोटी ड्रिल बनाता है: <strong>{w}</strong>।',
  'night drills': 'रात की ड्रिल', 'swarm attacks': 'झुंड हमले', 'faulty sensors': 'खराब सेंसर', 'bad weather': 'खराब मौसम',
  'Defend a real kind of site: an air base at night, a border post in fog, an airport in rain, a forward post in a dust storm.': 'एक असली तरह की जगह की रक्षा करें: रात में एयर बेस, कोहरे में सीमा चौकी, बारिश में हवाई अड्डा, धूल भरी आंधी में अग्रिम चौकी।',
  'Choose a mission →': 'मिशन चुनें →', 'Choose a mission': 'मिशन चुनें',
  'Each one is a fixed, scored raid on a real kind of site.': 'हर एक किसी असली तरह की जगह पर तय, स्कोर वाला हमला है।',
  'Night': 'रात', 'Day': 'दिन',
  // First-target coach
  'FIRST TARGET · STEP {n} OF {m} · {s}': 'पहला लक्ष्य · चरण {n} / {m} · {s}',
  'Take the gun': 'गन संभालें', 'Load': 'लोड', 'Find the drone': 'ड्रोन खोजें', 'Identify': 'पहचानें', 'Wait for FIRE': 'FIRE का इंतज़ार', 'Lock': 'लॉक', 'Safety off': 'सेफ़्टी हटाएँ', 'Fire': 'फ़ायर',
  'Target down! Well done.': 'लक्ष्य गिरा! शाबाश।',
  'Press {k} to report the kill, then find the next drone. You are on your own now.': 'किल रिपोर्ट करने के लिए {k} दबाएँ, फिर अगला ड्रोन खोजें। अब आप खुद संभालें।',
  'Click the view to take the gun': 'गन संभालने के लिए व्यू पर क्लिक करें',
  'The mouse then aims. {k} gives the mouse back.': 'फिर माउस से निशाना लगाएँ। {k} माउस वापस देता है।',
  'Loading…': 'लोड हो रहा है…', 'Press {k} to load': 'लोड करने के लिए {k} दबाएँ',
  'The loader puts the ammunition on the gun. Wait until it says loaded.': 'लोडर गन पर गोला-बारूद चढ़ाता है। "लोडेड" आने तक रुकें।',
  'Find the drone in the sky': 'आसमान में ड्रोन खोजें',
  'The ▲ marks on the compass at the top show where it is. Turn with the mouse, put it in the middle and press {k} to report it (or click it).': 'ऊपर कम्पास पर ▲ निशान बताते हैं कि वह कहाँ है। माउस से घुमाएँ, उसे बीच में लाएँ और रिपोर्ट करने के लिए {k} दबाएँ (या उस पर क्लिक करें)।',
  'Identify target {n}': 'लक्ष्य {n} पहचानें',
  'Look at its shape and how it flies, then press its number key (list on the right). Not sure? Press {k} for unknown.': 'उसका आकार और उड़ने का तरीका देखें, फिर उसका नंबर दबाएँ (सूची दाईं ओर)। पक्का नहीं? अज्ञात के लिए {k} दबाएँ।',
  'Target {n} is unknown: look closer': 'लक्ष्य {n} अज्ञात है: और ध्यान से देखें',
  'Target {n} is not a threat: do not fire': 'लक्ष्य {n} ख़तरा नहीं है: फ़ायर न करें',
  'Hold the right mouse button to look through the sight, or find the next drone ({k} cycles contacts).': 'साइट से देखने के लिए माउस का दायाँ बटन दबाए रखें, या अगला ड्रोन खोजें ({k} संपर्क बदलता है)।',
  'A friendly or civil aircraft is near the line of fire. Wait for FIRE again.': 'कोई मित्र या नागरिक विमान फ़ायर की लाइन के पास है। फिर से FIRE का इंतज़ार करें।',
  'Wait for FIRE from the control room': 'कंट्रोल रूम से FIRE का इंतज़ार करें',
  'They clear you to fire on hostiles you report. Keep the gun on the drone meanwhile.': 'आपके रिपोर्ट किए दुश्मनों पर वे फ़ायर की अनुमति देते हैं। तब तक गन ड्रोन पर रखें।',
  'Press {k} to lock target {n}': 'लक्ष्य {n} को लॉक करने के लिए {k} दबाएँ',
  'Put the drone near the middle first. Once locked, a ◇ diamond shows where to aim (the lead).': 'पहले ड्रोन को बीच के पास लाएँ। लॉक होने पर एक ◇ हीरा बताता है कि कहाँ निशाना लगाना है (लीड)।',
  'Press {k} to take the safety off': 'सेफ़्टी हटाने के लिए {k} दबाएँ',
  'The gun will not fire with the safety on.': 'सेफ़्टी लगी हो तो गन फ़ायर नहीं करेगी।',
  'Hold {k} to fire': 'फ़ायर के लिए {k} दबाए रखें',
  'Put the cross on the ◇ diamond (it turns green) and fire short bursts. Hold the right button for the sight.': 'क्रॉस को ◇ हीरे पर रखें (वह हरा हो जाता है) और छोटे बर्स्ट फ़ायर करें। साइट के लिए दायाँ बटन दबाए रखें।',
  'Put the cross a little ahead of the drone, where it is going, and fire short bursts.': 'क्रॉस को ड्रोन से थोड़ा आगे रखें, जहाँ वह जा रहा है, और छोटे बर्स्ट फ़ायर करें।',
  'LEFT CLICK': 'बायाँ क्लिक',
  // Gun-drill debrief
  '.': '।',
  'PASS': 'पास', 'NOT YET': 'अभी नहीं', 'pass mark {n}': 'पास अंक {n}',
  '{g} · debrief': '{g} · डीब्रीफ़', '3D field firing': '3D फ़ील्ड फ़ायरिंग', 'Control Room': 'कंट्रोल रूम', 'Reload drill': 'रीलोड ड्रिल',
  'All gun drills': 'सभी गन ड्रिल', 'Next drill →': 'अगली ड्रिल →',
  'Verified: same score when re-run from the log.': 'सत्यापित: लॉग से दोबारा चलाने पर वही स्कोर।', 'Re-run did not match.': 'दोबारा चलाने पर स्कोर मेल नहीं खाया।',
  'Expert on the same drill: {n}.': 'उसी ड्रिल पर विशेषज्ञ: {n}।',
  '{n} reloads done.': '{n} रीलोड पूरे।',
  'A drone hit your gun position. {k} of {h} hostile drones destroyed before that.': 'एक ड्रोन ने आपकी गन पोज़ीशन पर हमला किया। उससे पहले {h} में से {k} दुश्मन ड्रोन नष्ट।',
  'No hostile drone came within reach in this drill.': 'इस ड्रिल में कोई दुश्मन ड्रोन पहुँच में नहीं आया।',
  '{k} of {h} hostile drones destroyed': '{h} में से {k} दुश्मन ड्रोन नष्ट', ', {n} got through': ', {n} बच निकले',
  ' {n} fire-discipline errors.': ' {n} फ़ायर-अनुशासन गलतियाँ।',
  'hostile drones destroyed': 'दुश्मन ड्रोन नष्ट', 'your gun position': 'आपकी गन पोज़ीशन', 'got through': 'बच निकले', 'rounds fired': 'चलाए गए राउंड', ' · {n} without clearance': ' · {n} बिना अनुमति',
  'Fix these first': 'पहले इन्हें सुधारें', 'Nothing to fix: every rule at full marks.': 'सुधारने को कुछ नहीं: हर नियम में पूरे अंक।', 'Done well': 'अच्छा किया',
  'Full breakdown': 'पूरा विवरण', 'points by rule': 'नियम अनुसार अंक', ' · burst accuracy': ' · बर्स्ट सटीकता', ' · radio log': ' · रेडियो लॉग',
  'Detection': 'खोज', 'Identification': 'पहचान', 'Engagement decision': 'फ़ायर का फ़ैसला', 'Make ready': 'तैयारी', 'Stoppages and barrel heat': 'रुकावट और बैरल गर्मी',
  'Reaction to the fire order': 'फ़ायर आदेश पर प्रतिक्रिया', 'Ballistic solution': 'बैलिस्टिक समाधान', 'Burst accuracy': 'बर्स्ट सटीकता', 'Targets destroyed': 'नष्ट लक्ष्य',
  'Burst discipline': 'बर्स्ट अनुशासन', 'Kill assessment report': 'किल आकलन रिपोर्ट', 'Gun position struck': 'गन पोज़ीशन पर हमला', 'Raid priority': 'हमले में प्राथमिकता',
  'Fire discipline: clearance': 'फ़ायर अनुशासन: अनुमति', 'Safe arcs': 'सुरक्षित चाप', 'Not done': 'नहीं किया',
  // Field guide
  'Field guide': 'फ़ील्ड गाइड', 'Close': 'बंद करें',
  '<b>Friendly check says “matches flight plan”?</b> It is ours. Identify Friendly UAV, then <b>Hold</b>. Never fire.': '<b>फ़्रेंडली चेक कहता है “उड़ान योजना से मेल”?</b> यह हमारा है। Friendly UAV पहचानें, फिर <b>Hold</b>। कभी फ़ायर न करें।',
  '<b>RF signal shows a control or video link?</b> Someone is flying it by radio. <b>RF jam</b> cuts the link.': '<b>RF सिग्नल में कंट्रोल या वीडियो लिंक दिखता है?</b> कोई इसे रेडियो से उड़ा रहा है। <b>RF jam</b> लिंक काट देता है।',
  "<b>No radio emission, slow and erratic?</b> A bird. <b>Hold</b>; don't waste a weapon.": '<b>कोई रेडियो उत्सर्जन नहीं, धीमा और बेतरतीब?</b> पक्षी है। <b>Hold</b>; हथियार बर्बाद न करें।',
  '<b>No radio emission, fast and straight in, or flying in a group?</b> It navigates by satellite. Jamming fails; <b>GNSS spoof</b> works (it also hits nearby swarm drones).': '<b>कोई रेडियो उत्सर्जन नहीं, तेज़ और सीधा आता है, या झुंड में उड़ता है?</b> यह सैटेलाइट से नेविगेट करता है। जैमिंग काम नहीं करती; <b>GNSS spoof</b> काम करता है (यह पास के झुंड ड्रोन पर भी असर करता है)।',
  '<b>Weapon greyed out?</b> It is not in reach yet. Watch the coloured bar on its card, and handle the most urgent contact first.': '<b>हथियार धूसर है?</b> अभी पहुँच में नहीं है। उसके कार्ड पर रंगीन पट्टी देखें, और सबसे ज़रूरी संपर्क पहले संभालें।',
  '<b>How sure are you?</b> Say <b>Certain</b> only when friendly check, radio and behaviour all agree. If a sensor is down, say Confident.': '<b>आप कितने पक्के हैं?</b> <b>Certain</b> तभी कहें जब फ़्रेंडली चेक, रेडियो और व्यवहार सब मेल खाएँ। कोई सेंसर बंद हो तो Confident कहें।',
  '<b>Rain, fog or dust?</b> Radar paints blips less often and the camera only works close in. Do not wait for the picture: decide from <b>RF signal and behaviour</b>, and say Confident rather than Certain.': '<b>बारिश, कोहरा या धूल?</b> रडार कम बार ब्लिप दिखाता है और कैमरा केवल पास में काम करता है। तस्वीर का इंतज़ार न करें: <b>RF सिग्नल और व्यवहार</b> से तय करें, और Certain के बजाय Confident कहें।',
  '<b>Acoustic sensor.</b> It hears what radio cannot: a fibre-optic FPV screams like any racing quad but shows no radio. It only hears close in, less in towns, rain and dust, and a little further at night.': '<b>ध्वनि सेंसर।</b> यह वह सुनता है जो रेडियो नहीं पकड़ता: फ़ाइबर-ऑप्टिक FPV किसी रेसिंग क्वाड की तरह चीखता है पर रेडियो नहीं दिखाता। यह केवल पास में सुनता है, शहर, बारिश और धूल में कम, और रात में थोड़ा दूर तक।',
};
