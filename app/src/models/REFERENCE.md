# Vehicle model reference

Real dimensions and layout the models in this folder are built to. Metres,
x = along the car from its centre (+ = front), y = above rail / road.
Photos used for proportion / livery checks were compared side by side with
`/models.html` screenshots (not stored in the repo).

| Vehicle | Length | Width | Height | Layout used | Sources |
|---|---|---|---|---|---|
| TTC Toronto Rocket (Line 1, Line 4) | 23.19 cab car / 22.86 intermediate; 6 cars = 137.8, 4 cars = 92.1 | 3.137 | 3.645 (floor 1.105) | 4 double doors / side at ±2.85, ±8.55; trucks ±8.0, wheelbase 2.083, wheel Ø 0.711; stainless body, black raked cab mask with 3 panes, orange LED sign, red TTC logo on lower cab, full-width gangways | [Wikipedia: Toronto Rocket](https://en.wikipedia.org/wiki/Toronto_Rocket); Commons `Toronto_Rocket_Front.JPG`, `Toronto_Rocket_in_Yorkdale_2021_(cropped).jpg`, `Toronto_Rocket_Train_at_St_Andrew_Station,_March_25_2026.jpg` |
| TTC T1 (Line 2) | 22.9 | 3.14 | 3.65 | 4 double doors / side, flat end with centre door, fluted lower panels, 6-car sets | Commons `TTC T1 Subway Train at Kipling station, July 2 2025 (01).jpg` |
| TTC Flexity Outlook | 30.2 over couplers (28 body) | 2.54 | 3.84 | 5 modules A–B–C–B–A = 8.3 + 4.4 + 4.4 + 4.4 + 8.3; trucks under A (≈0.9 m inboard of centre) and C, B suspended; 4 doors on the right side only (behind each cab, centre of each B); low floor 0.36; red lower body, white stripe under the glass band, white band above, red roof fairings; near-vertical wraparound windscreen with the sign in the top of the glass, red lamp band, white bumper; pantograph on C | [Wikipedia: Flexity Outlook (Toronto)](https://en.wikipedia.org/wiki/Flexity_Outlook_(Toronto)); Commons `Flexity_outlook_4403_heading_south,_2014_08_31_(8)_(14918534190).jpg`, `TTC_Flexity_2571_with_ramp_deployed.jpg` |
| Line 5 Flexity Freedom | 31 (5 modules, B-2-B) | 2.65 | 3.6 | A 8.5, B 3.6, C 6.4; 4 doors / side; 2-unit trains on Line 5; white body, black glass + rounded black front, light-grey bumper, line-colour (livery) stripe | [Wikipedia: Bombardier Flexity Freedom](https://en.wikipedia.org/wiki/Bombardier_Flexity_Freedom); Commons `Line 5 Eglinton Crosstown - Bombardier Flexity Freedom.jpg` |
| Line 6 Citadis Spirit | 48 (7 modules modelled) | 2.65 | 3.6 | A 8.4, B 5.2, C 7.4 (A-B-C-B-C-B-A); white body, charcoal front mask sweeping back along the cab side | [Wikipedia: Line 6 Finch West](https://en.wikipedia.org/wiki/Line_6_Finch_West); Commons `Line 6 Citadis Spirit LRT 6500 at Humber College Station, August 19 2026 (02).jpg` |
| GO BiLevel coach / cab car | 25.908 | 3.0 | 4.851 (low floor 0.38) | drop-centre body (bottom 0.35 between ±9.0, 1.25 over trucks), vertical lower walls, sloped upper walls; 2 bi-parting doors / side at ±8.2; 8 lower + 9 upper windows; trucks ±11.0, wheelbase 2.59; white skirt / green lower band / white stripe / green upper band / white roof; cab car: flat end, green top band, centre door, chevrons, ditch lights | [Wikipedia: Bombardier BiLevel Coach](https://en.wikipedia.org/wiki/Bombardier_BiLevel_Coach); Commons `Lakeshore_West_GO_Train_Westbound.jpg` |
| GO MP40PH-3C | 20.73 | 3.05 body (3.24 handrails) | 4.72 | B-B trucks ≈ −6.9 / +6.5, wheelbase 2.84, wheel Ø 1.02; cab + short raked nose at the front, radiator hatch with fans at the rear; green body, white mid-stripe, white cab roof cap and white V on the nose, GO logo | [Wikipedia: MPI MPXpress](https://en.wikipedia.org/wiki/MPI_MPXpress); Commons `Toronto ON GOT-644 MPI-MP40PH-3C 2019-04-01 (5).jpg`, `GO_locomotive_623_outside_Union_Station.jpg` |
| UP Express (Nippon Sharyo DMU) | 25.9 per car, 3-car sets | 3.2 | 4.25 | cab cars at both ends, 2 doors / side per car, trucks ±9.0; silver upper body, champagne-gold lower band, orange pinstripe, dark skirt; black windscreen mask with 3 panes, twin headlights above, lamp clusters in the silver lower face, gold roof cap | [Wikipedia: Union Pearson Express](https://en.wikipedia.org/wiki/Union_Pearson_Express); Commons `Union_Pearson_Express_DMU_1010.JPG` |
| VIA Siemens Venture + Charger SCV-42 | Venture 25.9 (5-car sets: 4 coaches + cab car); Charger 21.79 | 3.2 / 3.05 | 4.27 / 4.39 | Charger truck centres 12.44; single plug doors at car ends; grey body, dark lower, yellow pinstripe, black face with yellow "cheeks", charcoal diagonal behind the cab | [Wikipedia: Siemens Venture](https://en.wikipedia.org/wiki/Siemens_Venture), [Siemens Charger](https://en.wikipedia.org/wiki/Siemens_Charger); Commons `Brampton_ON_VIA-Rail-Canada_Passenger-Train_2026-05-11_(3).jpg`, `Via Rail Charger - Exterior.jpg` |
| Nova Bus LFS 40' | 12.19 | 2.59 | 3.15 (3.25 hybrid pods) | wheelbase 6.20, front axle 2.45 behind the nose; front door ahead of the front axle, rear door mid-body (right side); TTC: white, red belt stripe + roof-line stripe (livery-tinted), black window band with framed windows, sign at top of the windscreen, roof HVAC / battery pods | [Wikipedia: Nova Bus LFS](https://en.wikipedia.org/wiki/Nova_Bus_LFS); Commons `TTC_nova_8531_bus_finch.jpg` |
| Nova Bus LFS Artic 62' | 18.90 | 2.59 | 3.15 | wheelbase front–mid 6.20, mid–rear 6.43; modelled as 11.0 front + 0.6 joint + 7.3 rear section | [Wikipedia: Nova Bus LFS](https://en.wikipedia.org/wiki/Nova_Bus_LFS) |

## Road vehicles (layers/traffic/models.ts)

Lengths are fixed by the sim (`sim/src/idm.rs` `LENGTH`): sedan 4.7, hatchback
4.1, SUV 4.9, pickup 5.6, van 5.3, truck 8.6. Widths / heights / wheelbases from
typical class representatives: sedan 1.82 × 1.45, wb 2.82 (Camry/Civic);
hatchback 1.78 × 1.46, wb 2.6 (Golf); SUV 1.93 × 1.76, wb 2.9 (Highlander);
crossover 1.86 × 1.68 (RAV4); pickup 2.0 × 1.94, wb 3.6 (F-150 SuperCrew,
shortened to 5.6); minivan 2.0 × 1.76, wb 3.08 (Grand Caravan); high-roof van
2.04 × 2.5, wb 3.35 (Transit); cab-over box truck 2.5 × 3.45 (Isuzu N-series,
26 ft box).
