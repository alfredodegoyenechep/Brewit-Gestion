// Lista local de asociaciones habituales en español e inglés, mantenida a mano.
// No es un padrón exhaustivo ni una fuente de probabilidades o identidad personal.
const words = text => new Set(text.trim().split(/\s+/));
const feminine = words(`
  adriana agustina aida alejandra alicia alma amalia amanda ana anabel anahi anais
  angela angeles angelica antonia araceli arantxa aurora ayleen barbara beatriz belen
  bernarda blanca camila carla carmen carolina catalina cecilia celeste celia clara
  claudia constanza consuelo cristina daniela debora deborah devora diana dolores elena elisa
  elisabeth elizabeth eloisa emilia esperanza estela ester esther eugenia eva evelyn
  fabiola fatima fernanda fiorella flor florencia francisca gabriela gloria graciela
  ines ingrid irene isabel isabella jacinta javiera jazmin jimena josefa josefina
  juana julia juliana julieta karen karina katia laura leonor leticia lilia liliana
  lorena lourdes lucia luciana luisa luz macarena magdalena maite malena manuela
  marcela margarita maria mariana mariela marisol marta martina mayra melina melissa
  mercedes micaela milena miranda monica natalia nathalie nelly nicole noelia norma
  olga paloma pamela paola patricia paula paulina paz pilar raquel rebeca regina
  renata rocio romina rosa rosalia rosana rosario roxana ruth sabrina sandra sara
  silvana silvia sofia soledad sonia susana tamara teresa trinidad valentina valeria
  vanessa veronica victoria violeta virginia viviana ximena yanina yolanda
  abigail ada adele alice allison alyssa amber amelia amy anna ann anne annette annie
  april audrey ava bella beth bethany bonnie brenda bridget brittany brooke caitlin
  candice caroline catherine charlotte chelsea cheryl chloe christina christine
  claire daisy danielle daphne denise donna dorothy edith eileen eleanor ella ellen
  ellie emily emma erica erin fiona frances georgia grace hannah harriet hazel
  heather helen holly imogen iris ivy jacqueline jade jane janet janice jasmine
  jennifer jenny jessica jill joan joanna jocelyn josephine joy joyce judith judy
  julie june kaitlyn katherine kathleen kathryn katie kayla kimberly kristen kristin
  lana lauren leah lesley lillian lily linda lisa liz louise lucy lydia madeline
  madison margaret marie marilyn martha mary megan melanie mia michelle molly nancy
  naomi natalie nina nora olivia paige phoebe rachel rebecca rita rose rosemary
  ruby sally samantha sarah savannah scarlett sharon sheila shirley sophia sophie
  stacey stella stephanie sue summer susan suzanne sylvia tiffany tracy valerie
  vanessa vera violet wendy whitney zoe zoey
`);
const masculine = words(`
  aaron abel abraham adan adrian agustin alberto alejandro alfonso alfredo alonso
  alvaro andres angel antonio arturo baltazar bautista benicio benito benjamin
  bernardo boris borja bruno camilo carlos cesar claudio cristian cristobal damian
  daniel dario david diego domingo eduardo elias emilio enrique ernesto esteban
  eugenio ezequiel fabian federico felipe fernando francisco gabriel gaspar gerardo
  german gonzalo gregorio guillermo gustavo hector hernan humberto hugo ignacio
  ismael ivan jacobo jaime javier jeronimo jesus joaquin jorge jose josue juan
  julian julio lautaro leon leonardo lorenzo luca lucas luciano luis manuel marcelo marco
  marcos mario martin mateo matias mauricio maximiliano miguel moises nahuel nicolas
  octavio omar orlando oscar pablo pascual patricio pedro rafael ramiro ramon raul
  renato ricardo roberto rodolfo rodrigo rolando ruben salvador samuel santiago
  sebastian sergio simon teodoro tomas valentin vicente victor walter
  adam aidan alan albert alexander alfred andrew anthony arthur austin barry
  ben bernard blake bradley brian bruce bryan caleb calvin carl charles christian
  christopher colin connor craig curtis dean dennis derek dominic donald douglas
  dylan edgar edmund edward edwin eli elijah elliot eric ethan evan felix finn
  francis frank frederick gareth gary gavin george gerald gilbert gordon graham
  grant gregory harold harrison harry harvey henry howard hugh ian isaac jack
  jackson jacob jake james jason jeffrey jeremy jesse jim joe joel john jonathan
  joseph joshua julian justin keith kenneth kevin kyle lawrence leo leonard lewis
  liam logan louis luke malcolm marc mark mason matthew max michael miles
  milton nathan nathaniel neil nicholas nigel noah nolan oliver owen patrick paul
  peter philip phillip ralph randall raymond reginald richard robert roger ronald
  ross roy russell ryan scott sean seth shane shaun simon stanley stephen steven
  stuart terence terry theodore thomas timothy toby todd tony travis trevor tyler
  vernon vincent warren wayne wesley william zachary
`);
// La ambigüedad entre idiomas o diminutivos tiene prioridad sobre las listas.
const ambiguous = words(`alex andrea andy ariel ashley aubrey avery cameron camille
  casey charlie chris corey cris cruz dakota dominique drew ellis fran guadalupe
  hayden jaime jamie jean jessie jordan jul Jules kelly kim lee leslie lindsay
  lynn mar morgan pat peyton quinn reese rene riley robin rowan sam sasha shannon
  shawn skyler taylor terry toni`.toLowerCase());
module.exports = { feminine, masculine, ambiguous };
