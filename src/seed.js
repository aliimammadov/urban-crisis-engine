// Simulated city data (Baku-like). All coordinates are approximate and for demo only.

export const districts = [
  { id: 'nasimi', name: { az: 'Nəsimi', en: 'Nasimi', ru: 'Насими' }, lat: 40.4093, lng: 49.8330 },
  { id: 'yasamal', name: { az: 'Yasamal', en: 'Yasamal', ru: 'Ясамал' }, lat: 40.3850, lng: 49.8150 },
  { id: 'narimanov', name: { az: 'Nərimanov', en: 'Narimanov', ru: 'Наримановский' }, lat: 40.4120, lng: 49.8650 },
  { id: 'xatai', name: { az: 'Xətai', en: 'Khatai', ru: 'Хатаи' }, lat: 40.3800, lng: 49.8900 },
  { id: 'sabail', name: { az: 'Səbail', en: 'Sabail', ru: 'Сабаил' }, lat: 40.3550, lng: 49.8350 },
  { id: 'binagadi', name: { az: 'Binəqədi', en: 'Binagadi', ru: 'Бинагадинский' }, lat: 40.4600, lng: 49.8200 },
  { id: 'sabunchu', name: { az: 'Sabunçu', en: 'Sabunchu', ru: 'Сабунчи' }, lat: 40.4400, lng: 49.9400 },
  { id: 'surakhani', name: { az: 'Suraxanı', en: 'Surakhani', ru: 'Сураханы' }, lat: 40.4150, lng: 49.9900 },
];

// active:false => reserve point that can be opened by a dispatcher decision
// accessible:true => ramp / step-free entrance (usable by wheelchair users); `access` lists the features
export const points = [
  { id: 'p1', type: 'park', name: { az: 'Dənizkənarı Milli Park', en: 'Seaside National Park', ru: 'Приморский нацпарк' }, lat: 40.3680, lng: 49.8450, capacity: 8000, occupied: 1200, active: true, accessible: true, access: ['ramp', 'wide_doors'] },
  { id: 'p2', type: 'stadium', name: { az: 'Bakı Olimpiya Stadionu', en: 'Baku Olympic Stadium', ru: 'Бакинский олимпийский стадион' }, lat: 40.4300, lng: 49.9190, capacity: 20000, occupied: 3000, active: true, accessible: true, access: ['ramp', 'lift', 'accessible_wc'] },
  { id: 'p3', type: 'shelter', name: { az: 'Nəsimi Sığınacağı №1', en: 'Nasimi Shelter #1', ru: 'Убежище Насими №1' }, lat: 40.4050, lng: 49.8400, capacity: 1200, occupied: 400, active: true, accessible: false, access: [] },
  { id: 'p4', type: 'school', name: { az: 'Yasamal 132 saylı məktəb', en: 'Yasamal School #132', ru: 'Ясамал школа №132' }, lat: 40.3900, lng: 49.8050, capacity: 900, occupied: 300, active: true, accessible: false, access: [] },
  { id: 'p5', type: 'park', name: { az: 'Zərifə Əliyeva Parkı', en: 'Zarifa Aliyeva Park', ru: 'Парк Зарифы Алиевой' }, lat: 40.4130, lng: 49.8500, capacity: 3500, occupied: 500, active: true, accessible: true, access: ['ramp'] },
  { id: 'p6', type: 'shelter', name: { az: 'Binəqədi Sığınacağı', en: 'Binagadi Shelter', ru: 'Убежище Бинагади' }, lat: 40.4520, lng: 49.8300, capacity: 1500, occupied: 200, active: true, accessible: false, access: [] },
  { id: 'p7', type: 'stadium', name: { az: 'Tofiq Bəhramov Stadionu', en: 'Tofiq Bahramov Stadium', ru: 'Стадион Тофика Бахрамова' }, lat: 40.3950, lng: 49.8750, capacity: 31000, occupied: 2000, active: true, accessible: true, access: ['ramp', 'lift', 'wide_doors', 'accessible_wc'] },
  { id: 'p8', type: 'school', name: { az: 'Xətai 6 saylı məktəb', en: 'Khatai School #6', ru: 'Хатаи школа №6' }, lat: 40.3750, lng: 49.8950, capacity: 700, occupied: 150, active: true, accessible: false, access: [] },
  { id: 'p9', type: 'park', name: { az: 'Sabunçu Mərkəzi Parkı', en: 'Sabunchu Central Park', ru: 'Центральный парк Сабунчи' }, lat: 40.4450, lng: 49.9300, capacity: 2500, occupied: 100, active: true, accessible: true, access: ['ramp'] },
  // reserve points
  { id: 'r1', type: 'park', name: { az: 'Ehtiyat toplanış: Bulvar zonası', en: 'Reserve: Boulevard zone', ru: 'Резерв: зона Бульвара' }, lat: 40.3600, lng: 49.8500, capacity: 4000, occupied: 0, active: false, accessible: true, access: ['ramp'] },
  { id: 'r2', type: 'stadium', name: { az: 'Ehtiyat toplanış: Dalğa Arena', en: 'Reserve: Dalga Arena', ru: 'Резерв: Далга Арена' }, lat: 40.4200, lng: 49.8800, capacity: 6000, occupied: 0, active: false, accessible: true, access: ['ramp', 'lift'] },
  { id: 'r3', type: 'school', name: { az: 'Ehtiyat toplanış: Nəsimi məktəbi', en: 'Reserve: Nasimi school', ru: 'Резерв: школа Насими' }, lat: 40.4000, lng: 49.8250, capacity: 1000, occupied: 0, active: false, accessible: false, access: [] },
  { id: 'r4', type: 'park', name: { az: 'Ehtiyat toplanış: Binəqədi parkı', en: 'Reserve: Binagadi park', ru: 'Резерв: парк Бинагади' }, lat: 40.4650, lng: 49.8100, capacity: 3000, occupied: 0, active: false, accessible: true, access: ['ramp'] },
];

export const brigades = [
  { id: 'b1', kind: 'rescue', name: 'Rescue-1', lat: 40.3990, lng: 49.8450, status: 'available' },
  { id: 'b2', kind: 'fire', name: 'Fire-1', lat: 40.3870, lng: 49.8300, status: 'available' },
  { id: 'b3', kind: 'medical', name: 'Medical-1', lat: 40.4150, lng: 49.8600, status: 'available' },
  { id: 'b4', kind: 'rescue', name: 'Rescue-2', lat: 40.4400, lng: 49.9250, status: 'available' },
  { id: 'b5', kind: 'fire', name: 'Fire-2', lat: 40.3700, lng: 49.8800, status: 'available' },
  { id: 'b6', kind: 'medical', name: 'Medical-2', lat: 40.4500, lng: 49.8250, status: 'available' },
  // wheelchair-lift vehicles / medical transport for priority (reduced-mobility) citizens
  { id: 'b7', kind: 'accessible_transport', name: 'Accessible-1', lat: 40.4020, lng: 49.8500, status: 'available' },
  { id: 'b8', kind: 'accessible_transport', name: 'Accessible-2', lat: 40.4300, lng: 49.9000, status: 'available' },
];
