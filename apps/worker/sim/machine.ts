export const machine = {
  cradleX: -0.028,
  cradleY: -0.11,
  loadX: 0.077,
  loadY: 0.055,
  latchOffset: 0.048,
  latchY: 0.154,
  releaseTravel: 0.02,
  latchTravel: 0.028,
  coverTravel: 0.115,
};

export function machineGeometry(seed: number) {
  const direction = seed % 2 === 0 ? -1 : 1;
  return { ...machine, direction, latchX: machine.loadX + direction * machine.latchOffset };
}

export function machineFixture(seed: number) {
  const { cradleX, cradleY, loadX, loadY, latchX, latchY, latchTravel, coverTravel, direction } =
    machineGeometry(seed);
  const railX = loadX + (direction * coverTravel) / 2;
  const railHalfLength = 0.046 + coverTravel / 2;
  const railEnd = railX + direction * (railHalfLength - 0.008);
  return `
    <body name="cradle" pos="${cradleX} ${cradleY} 0">
      <geom name="cradle_base" type="box" size=".029 .038 .0005" pos="0 0 .0005" rgba=".31 .53 .74 1" contype="0" conaffinity="0"/>
      ${[-0.026, 0.026]
        .map(
          (y) => `
        <geom type="box" size=".028 .010 .013" pos="0 ${y} .013" rgba=".29 .40 .54 1"/>
        <geom type="box" size=".008 .010 .010" pos="-.019 ${y} .036" rgba=".34 .64 .84 1"/>
        <geom type="box" size=".008 .010 .010" pos=".019 ${y} .036" rgba=".34 .64 .84 1"/>
      `,
        )
        .join("")}
    </body>
    <body name="fixture" pos="${loadX} ${loadY} 0">
      <geom type="box" size=".065 .065 .003" pos="0 0 .003" rgba=".23 .37 .37 1" contype="5"/>
      <geom type="box" size=".020 .038 .0006" pos="0 0 .0064" rgba=".30 .68 .56 1" contype="0" conaffinity="0"/>
      <geom type="box" size=".009 .042 .025" pos="-.031 0 .031" rgba=".31 .69 .66 .86" contype="5"/>
      <geom type="box" size=".009 .042 .025" pos=".031 0 .031" rgba=".31 .69 .66 .86" contype="5"/>
      <geom type="box" size=".064 .008 .039" pos="0 .057 .045" rgba=".26 .51 .51 .83" contype="5"/>
    </body>
    ${[-0.058, 0.058]
      .map(
        (offset, index) => `
      <geom name="cover_rail_${index}" type="box" pos="${railX} ${loadY + offset} .087" size="${railHalfLength} .004 .004" rgba=".72 .64 .39 1" contype="0" conaffinity="0"/>
      <geom name="cover_rail_support_${index}" type="box" pos="${railEnd} ${loadY + offset} .042" size=".008 .007 .042" rgba=".30 .44 .46 1" contype="0" conaffinity="0"/>
    `,
      )
      .join("")}
    <body name="cover" pos="${loadX} ${loadY} .098" gravcomp="1">
      <joint name="cover_slide" type="slide" axis="${direction} 0 0" range="0 ${coverTravel}" damping="1.4" frictionloss=".35" armature=".02"/>
      <geom type="box" size=".046 .055 .006" rgba=".35 .56 .61 1" mass=".16" contype="5"/>
      <geom name="cover_handle" type="box" size=".015 .010 .012" pos="0 0 .018" rgba=".74 .83 .87 1" mass=".025" contype="5" friction="3 .02 .002"/>
      <geom type="box" size=".006 .012 .008" pos="${direction * 0.033} .063 0" rgba=".52 .62 .67 1" mass=".006" contype="5"/>
    </body>
    <geom name="latch_mount" type="box" pos="${latchX} ${latchY} .006" size=".019 .021 .006" rgba=".24 .39 .41 1" contype="5"/>
    <geom name="latch_guide" type="cylinder" pos="${latchX} ${latchY} .036" size=".015 .025" rgba=".30 .44 .46 1" contype="5"/>
    <body name="latch" pos="${latchX} ${latchY} .097" gravcomp="1">
      <joint name="latch_slide" type="slide" axis="0 0 1" range="${-latchTravel} 0" damping="1" stiffness="80" armature=".004"/>
      <geom name="latch_stem" type="cylinder" pos="0 0 -.021" size=".005 .022" rgba=".62 .72 .76 1" mass="0" contype="0" conaffinity="0"/>
      <geom name="latch_button" type="box" size=".011 .012 .009" pos="0 0 .007" rgba=".85 .25 .25 1" mass=".02"/>
      <geom type="box" size=".006 .016 .007" pos="0 -.016 0" rgba=".75 .30 .30 1" mass=".012"/>
    </body>
  `;
}
