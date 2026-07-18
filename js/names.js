// names.js — fun seeded vehicle names
const ADJ = ['Crimson', 'Turbo', 'Atomic', 'Midnight', 'Rusty', 'Royal', 'Neon', 'Thunder',
  'Cosmic', 'Mighty', 'Wild', 'Chrome', 'Golden', 'Blazing', 'Iron', 'Lucky', 'Retro',
  'Savage', 'Silent', 'Solar', 'Dusty', 'Electric', 'Frosty', 'Rapid', 'Rogue', 'Grand',
  'Pocket', 'Howling', 'Copper', 'Velvet'];
const NOUN = ['Comet', 'Falcon', 'Badger', 'Stallion', 'Rhino', 'Viper', 'Otter', 'Bandit',
  'Pioneer', 'Rocket', 'Bison', 'Wasp', 'Puma', 'Hammer', 'Nomad', 'Drifter', 'Maverick',
  'Titan', 'Scarab', 'Cobra', 'Griffin', 'Walrus', 'Yeti', 'Piranha', 'Sparrow', 'Mule',
  'Tornado', 'Pickle', 'Mantis', 'Burrito'];
const SUF = ['GT', 'XL', 'Mk II', 'Turbo', '3000', 'V8', 'RS', '4x4', 'Deluxe', 'Sport',
  'LE', 'Prime', 'EX', 'ZR', '500', 'S'];

const FLAVOR = {
  taxi: (r) => `City Cab №${r.int(2, 99)}`,
  police: (r) => `Patrol Unit ${r.int(10, 99)}`,
  policesuv: (r) => `Patrol Unit ${r.int(10, 99)}`,
  fire: (r) => `Engine No. ${r.int(1, 49)}`,
  ambulance: (r) => `Medic ${r.int(1, 60)}`,
  schoolbus: (r) => `District ${r.int(1, 30)} Bus`,
  citybus: (r) => `Route ${r.int(1, 99)}`,
  doubledecker: (r) => `Route ${r.int(1, 42)} Express`,
  mail: (r) => `Post Runner ${r.int(1, 99)}`,
  icecream: (r) => r.pick(['Mr. Swirly', 'Frosty Wheels', 'Scoop Dream', 'Sundae Express', 'The Sprinkler']),
  foodtruck: (r) => r.pick(['Taco Comet', 'Burger Baron', 'Waffle Wagon', 'Noodle Rocket', 'Pizza Pronto']),
  garbage: (r) => r.pick(['Bin Baron', 'Trash Titan', 'The Compactor', 'Curb Crawler']),
  armyjeep: (r) => `Recon ${r.int(1, 99)}`,
  armytruck: (r) => `Convoy ${r.int(1, 99)}`,
  tractor: (r) => r.pick(['Old Reliable', 'Field Marshal', 'Hay Maker', 'The Plougher', 'Mud Duke']),
  forklift: (r) => `Lift ${r.int(1, 20)}`,
  tow: (r) => r.pick(['Hook & Go', 'Night Hauler', 'Rescue Rig', 'The Snatcher']),
  plow: (r) => r.pick(['Snow Duke', 'Blizzard Boss', 'The Scraper', 'Frost Fighter']),
  bulldozer: (r) => r.pick(['Earth Mover', 'The Flattener', 'Dirt Duke', 'Big Push']),
  excavator: (r) => r.pick(['The Digger', 'Trench King', 'Big Scoop', 'Ground Breaker']),
  loader: (r) => `Loader ${r.int(1, 40)}`,
  roller: (r) => r.pick(['Steamroller', 'The Flatline', 'Asphalt King', 'Big Squish']),
  haultruck: (r) => `Haul ${r.int(50, 99)}`,
  crane: (r) => r.pick(['Sky Hook', 'High Reach', 'The Lifter', 'Boom Boss']),
  dragster: (r) => r.pick(['Quarter Mile', 'Nitro Ghost', 'Smoke Show', 'The Rail']),
  tram: (r) => `Line ${r.int(1, 24)} Tram`,
  bendybus: (r) => `Route ${r.int(1, 60)} Flex`,
  armored: (r) => r.pick(['Vault Runner', 'Iron Wagon', 'Secure One', 'The Brink']),
  stepvan: (r) => r.pick(['Parcel Pro', 'Doorstep', 'Quick Drop', 'The Courier']),
  carcarrier: (r) => r.pick(['Auto Hauler', 'Six Pack', 'The Stacker']),
  snowmobile: (r) => r.pick(['Powder Hound', 'Frost Sled', 'The Blizzard', 'Snow Streak']),
  trophy: (r) => `Baja ${r.int(1, 99)}`,
  lowrider: (r) => r.pick(['Slow & Low', 'El Rey', 'Boulevard King', 'Midnight Cruise', 'Gold Chain']),
  firechief: (r) => `Chief ${r.int(1, 12)}`,
  swat: (r) => `Tac Unit ${r.int(1, 20)}`,
  gtcoupe: (r) => r.pick(['Continental', 'Grand Milano', 'Silver Arrow', 'Autobahn Ghost']),
  quad: (r) => r.pick(['Mud Hornet', 'Trail Rat', 'Four Paws', 'Dirt Flea']),
  humvee: (r) => `Patrol ${r.int(1, 99)}`,
  kei: (r) => r.pick(['Little Helper', 'Bean Hauler', 'Tiny Titan', 'Pocket Truck']),
  stockcar: (r) => `Car #${r.int(2, 99)}`,
  hearse: (r) => r.pick(['Last Ride', 'The Quiet One', 'Midnight Coach', 'Solemn Express']),
  roadtrain: (r) => r.pick(['Outback Express', 'Triple Trouble', 'Long Haul Legend', 'Desert Freighter']),
  suvboat: (r) => r.pick(['Lake Day', 'Gone Fishin\'', 'Weekend Wake', 'Reel Deal']),
  pickupcamper: (r) => r.pick(['Home on Wheels', 'The Great Escape', 'Roam Sweet Roam', 'Trailblazer']),
  tractorhay: (r) => r.pick(['Harvest Run', 'Hay Day', 'Bale Mail', 'Golden Load']),
};

export function genName(r, typeId) {
  const flavor = FLAVOR[typeId];
  if (flavor && r.chance(0.75)) return flavor(r);
  const adj = r.pick(ADJ), noun = r.pick(NOUN);
  if (r.chance(0.62)) return `${adj} ${noun} ${r.pick(SUF)}`;
  if (r.chance(0.5)) return `${adj} ${noun}`;
  return `${noun} ${r.int(100, 990)}`;
}
