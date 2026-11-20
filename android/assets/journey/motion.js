(() => {
  "use strict";
  // The Prince is a small felt puppet: legs, coat, head and a four-link scarf move on their own.
  const piece=document.getElementById("prince");
  const rig=piece && piece.querySelector(".prince-rig");
  const part=name=>rig && rig.querySelector("."+name);
  const upper=part("pr-upper"), head=part("pr-head"), legL=part("pr-legl"), legR=part("pr-legr"), lid=part("pr-lid");
  const links=rig ? [...rig.querySelectorAll(".pr-link")] : [];
  const media=matchMedia("(prefers-reduced-motion: reduce)");
  const {sin,max,min}=Math;
  let paused=true, visible=true, settings=false, token=0, energy=0, last=0;
  let pose={crouch:0,air:0,eager:false}, blinkAt=2.5, air=0, rise=0;
  function canRun() { return !!rig && visible && !paused && !settings && !media.matches && !document.hidden; }
  function rest() {
    if (!rig) return;
    for (const node of [upper,head,legL,legR,...links]) node.style.transform="";
    lid.style.opacity="0";
  }
  function animate(tick) {
    token=0;
    if (!canRun()) { rest(); return; }
    const t=tick/1000, step=min(.05,max(.001,(tick-last)/1000));
    last=tick;
    // Vertical speed of the hop: the scarf lags behind the body.
    rise+=((pose.air-air)/step-rise)*min(1,step*14);
    air=pose.air;
    const crouch=pose.crouch;
    const gust=(.62+.3*sin(t*.83)+.2*sin(t*.47+1.7)+.12*sin(t*2.3))*(1+1.6*energy);
    const breath=sin(t*1.55);
    const sway=(sin(t*.78)+.45*sin(t*.33+1.1))*1.1;
    const eager=pose.eager ? sin(t*7.4) : 0;
    upper.style.transform="translateY("+(crouch*3.2).toFixed(2)+"%) rotate("+(sway*(1-air)-air*4+eager*.8).toFixed(2)+
      "deg) scale("+(1+.006*breath).toFixed(4)+","+(1+.012*breath-crouch*.03).toFixed(4)+")";
    // Now and then he lifts his head toward the sky.
    const glance=-7*max(0,sin(t*.17+2))**6;
    head.style.transform="rotate("+(sin(t*.52+.4)*2.2+sin(t*1.27)*1.1+glance+air*6-crouch*5).toFixed(2)+"deg)";
    const flow=t*(3.1+2.6*energy);
    links.forEach((link,i)=>{
      const wave=(2.2+1.5*i)*gust*sin(flow-i*.95)+1.2*gust*sin(flow*1.7-i*1.4);
      const drag=max(-24,min(24,-rise*5.5*(1+.4*i)));
      link.style.transform="rotate("+(wave+drag+crouch*(3+i)).toFixed(2)+"deg)";
    });
    legL.style.transform="rotate("+(air*22+eager*5).toFixed(2)+"deg) scaleY("+(1-.1*crouch).toFixed(3)+")";
    legR.style.transform="rotate("+(-air*16-eager*5).toFixed(2)+"deg) scaleY("+(1-.1*crouch).toFixed(3)+")";
    if (t>=blinkAt+.13) blinkAt=t+(Math.random()<.2 ? .22 : 2.2+Math.random()*4.2);
    lid.style.opacity=t>=blinkAt && air<.05 ? "1" : "0";
    token=requestAnimationFrame(animate);
  }
  function sync() {
    if (canRun()) { if (!token) { last=performance.now(); token=requestAnimationFrame(animate); } }
    else { if (token) cancelAnimationFrame(token); token=0; rest(); }
  }
  window.RouteMotion={
    show(phase, disabled) { paused=!!disabled; sync(); },
    energy(value) { energy=max(0,min(1,value)); },
    pose(next) { Object.assign(pose,next); },
    settings(isOpen) { settings=isOpen; sync(); }
  };
  document.addEventListener("visibilitychange",sync);
  media.addEventListener("change",sync);
  new IntersectionObserver(([entry])=>{visible=entry.isIntersecting; sync();})
    .observe(document.querySelector(".scene"));
})();
