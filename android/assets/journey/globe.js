(() => {
  "use strict";
  const locations = {
    vilnius:{name:"Вильнюс",lat:54.6892,lon:25.2798,offset:[.12,-.105]},
    zurich: {name:"Цюрих", lat:47.3769, lon:8.5417, offset:[-.19,-.04]},
    sofia: {name:"София", lat:42.6977, lon:23.3219, offset:[0,.11]},
    chisinau: {name:"Кишинёв", lat:47.0105, lon:28.8638, offset:[.18,-.04]},
  };
  const rad = Math.PI / 180;
  const sphere = {x:.481,y:.498,r:.445};
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  const dot = ([x,y,z],[a,b,c]) => x*a+y*b+z*c;
  const cross = ([x,y,z],[a,b,c]) => [y*c-z*b,z*a-x*c,x*b-y*a];
  const unit = vector => {
    const length = Math.hypot(...vector);
    return vector.map(value => value/length);
  };

  function direction(lat,lon) {
    const phi=lat*rad, lambda=lon*rad;
    return [Math.cos(phi)*Math.sin(lambda),Math.sin(phi),Math.cos(phi)*Math.cos(lambda)];
  }
  const forward=direction(45,28);
  const right=unit(cross([0,1,0],forward));
  // The columns transform a direction from the screen to the globe.
  const home=[right,cross(forward,right),forward].flat();
  function project(camera,lat,lon) {
    const [x,y,z]=direction(lat,lon);
    return [
      sphere.x+sphere.r*(x*camera[0]+y*camera[1]+z*camera[2]),
      sphere.y-sphere.r*(x*camera[3]+y*camera[4]+z*camera[5]),
      x*camera[6]+y*camera[7]+z*camera[8],
    ];
  }

  function trackball(x,y) {
    const right=(x-sphere.x)/sphere.r, up=(sphere.y-y)/sphere.r;
    const distance=right*right+up*up;
    const depth=distance<.81 ? Math.sqrt(1-distance) : .19/Math.sqrt(distance-.62);
    return unit([right,up,depth]);
  }

  function turn(camera,from,to) {
    // The inverse of the pointer rotation updates the screen-to-globe basis.
    const [x,y,z,w]=unit([...cross(to,from),1+dot(from,to)]);
    const right=[1-2*(y*y+z*z),2*(x*y+w*z),2*(x*z-w*y)];
    const up=[2*(x*y-w*z),1-2*(x*x+z*z),2*(y*z+w*x)];
    const forward=[2*(x*z+w*y),2*(y*z-w*x),1-2*(x*x+y*y)];
    return [right,up,forward].flatMap(([a,b,c]) =>
      [0,1,2].map(i => a*camera[i]+b*camera[i+3]+c*camera[i+6]));
  }

  // NOAA fractional-year approximation. Longitude is positive eastwards.
  function sunlight(date) {
    const year=date.getUTCFullYear(), start=Date.UTC(year,0,1);
    const days=(Date.UTC(year+1,0,1)-start)/86400000;
    const gamma=2*Math.PI*((date.getTime()-start)/86400000-.5)/days;
    const c=Math.cos, s=Math.sin;
    const eq=229.18*(.000075+.001868*c(gamma)-.032077*s(gamma)-.014615*c(2*gamma)-.040849*s(2*gamma));
    const decl=.006918-.399912*c(gamma)+.070257*s(gamma)-.006758*c(2*gamma)+.000907*s(2*gamma)-.002697*c(3*gamma)+.00148*s(3*gamma);
    const minutes=date.getUTCHours()*60+date.getUTCMinutes()+date.getUTCSeconds()/60;
    return direction(decl/rad,180-(minutes+eq)/4);
  }

  function landMask() {
    const surface=document.createElement("canvas");
    const width=surface.width=2048;
    const height=surface.height=1024;
    const ctx=surface.getContext("2d",{willReadFrequently:true});
    ctx.fillStyle="#000";ctx.fillRect(0,0,width,height);
    ctx.fillStyle="#f00";
    ctx.strokeStyle="#ffec00";ctx.lineWidth=1.7;ctx.lineCap="round";
    ctx.setLineDash([2.5,4.5]);
    for (const ring of window.RouteLand || []) {
      ctx.beginPath();
      ring.forEach(([lon,lat],i) => {
        const x=(lon+180)*width/360, y=(90-lat)*height/180;
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.save();ctx.clip();ctx.stroke();ctx.restore();
    }
    ctx.globalCompositeOperation="lighter";
    const panels=new Path2D();
    for(const ring of window.RouteLand || []){
      ring.forEach(([lon,lat],i)=>panels[i?"lineTo":"moveTo"]((lon+180)*width/360,(90-lat)*height/180));
      panels.closePath();
    }
    ctx.save();ctx.clip(panels);ctx.setLineDash([]);
    for(let row=-1;row<15;row++)for(let col=-1;col<24;col++){
      const node=(i,j)=>[90*i+17*Math.sin(j*1.8+i),77*j+16*Math.sin(i*1.6+j)];
      const points=[node(col,row),node(col+1,row),node(col+1,row+1),node(col,row+1)];
      ctx.beginPath();ctx.moveTo(...points[0]);
      points.forEach(([x,y],i)=>{const [u,v]=points[(i+1)%4];ctx.quadraticCurveTo((x+u)/2+5,(y+v)/2-7,u,v)});
      ctx.closePath();ctx.fillStyle="rgb(0,0,"+Math.round(85+59*Math.sin(col*3.2+row*1.7))+")";ctx.fill();
      ctx.setLineDash([2,5]);ctx.strokeStyle="#003400";ctx.lineWidth=1.1;ctx.stroke();
    }
    const xy=(lon,lat)=>[(lon+180)*width/360,(90-lat)*height/180];
    for(const ridge of [[[5.5,44.5],[7.1,45.5],[8.4,46],[10.3,46.8],[12.7,47.1],[15,47.5]],
      [[-76,-10],[-71,-17],[-68,-25],[-70,-35]],[[74,35],[80,30.5],[87,28],[95,28.5]]]){
      ctx.setLineDash([]);ctx.lineJoin="round";ctx.beginPath();
      ridge.forEach(([lon,lat],i)=>ctx[i?"lineTo":"moveTo"](...xy(lon,lat)));
      ctx.strokeStyle="#00004c";ctx.lineWidth=7;ctx.stroke();ctx.strokeStyle="#007900";ctx.lineWidth=1.8;ctx.stroke();
    }
    ctx.restore();
    const pixels=ctx.getImageData(0,0,width,height).data;
    return (x,y,z) => {
      const lon=Math.atan2(x,z), lat=Math.asin(clamp(y,-1,1));
      const column=Math.floor((lon+Math.PI)/(2*Math.PI)*width)%width;
      const row=Math.min(height-1,Math.floor((.5-lat/Math.PI)*height));
      const at=(row*width+column)*4;
      return pixels[at]+256*pixels[at+1]+65536*pixels[at+2];
    };
  }

  function landCube(gl,sample) {
    const size=512;
    const pixels=new Uint8Array(3*size*size);
    // OpenGL cube face order and orientation.
    const faces=[(s,t)=>[1,-t,-s],(s,t)=>[-1,-t,s],(s,t)=>[s,1,t],
                 (s,t)=>[s,-1,-t],(s,t)=>[s,-t,1],(s,t)=>[-s,-t,-1]];
    const grid=Array.from({length:size},(_,i)=>2*(i+.5)/size-1);
    faces.forEach((face,index) => {
      for (let y=0; y<size; y++) {
        const t=grid[y];
        for (let x=0; x<size; x++) {
          const s=grid[x];
          const normalizer=1/Math.sqrt(1+s*s+t*t);
          const [rx,ry,rz]=face(s,t);
          const mask=sample(rx*normalizer,ry*normalizer,rz*normalizer),at=3*(y*size+x);
          pixels[at]=mask&255;pixels[at+1]=(mask>>8)&255;pixels[at+2]=mask>>16;
        }
      }
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X+index,0,gl.RGB,size,size,0,gl.RGB,gl.UNSIGNED_BYTE,pixels);
    });
  }

  function feltTexture(ready) {
    const source=window.RouteMotionTextures?.home;
    if (!source) return;
    const art=new Image();
    art.onload=() => {
      const canvas=document.createElement("canvas");
      const size=128, overlap=32, side=size+overlap;
      canvas.width=canvas.height=side;
      const ctx=canvas.getContext("2d");
      const pixels=new Uint8Array(size*size*4).fill(255);
      const blend=(a,b,t)=>a+(b-a)*t;
      const fade=i=>{
        const t=Math.min(1,i/overlap);
        return t*t*(3-2*t);
      };
      // Sample the ocean and the center of Africa in the original felt artwork.
      for (const [channel,left,top,span] of [[0,222,214,116],[1,407,258,67]]) {
        const sx=art.naturalWidth/650, sy=art.naturalHeight/650;
        ctx.drawImage(art,left*sx,top*sy,span*sx,span*sy,0,0,side,side);
        const sample=ctx.getImageData(0,0,side,side).data;
        const tones=Float32Array.from({length:side*side},(_,i) =>
          .2126*sample[4*i]+.7152*sample[4*i+1]+.0722*sample[4*i+2]);
        const detail=(x,y)=>{
          const at=(col,row)=>tones[clamp(row,0,side-1)*side+clamp(col,0,side-1)];
          // Remove baked-in lighting while keeping the fibers.
          return at(x,y)-.25*(at(x-7,y)+at(x+7,y)+at(x,y-7)+at(x,y+7));
        };
        for (let y=0; y<size; y++) {
          for (let x=0; x<size; x++) {
            let tone=detail(x,y);
            if (x<overlap) tone=blend(detail(x+size,y),tone,fade(x));
            if (y<overlap) {
              let wrap=detail(x,y+size);
              if (x<overlap) wrap=blend(detail(x+size,y+size),wrap,fade(x));
              tone=blend(wrap,tone,fade(y));
            }
            pixels[4*(y*size+x)+channel]=clamp(128+tone*2.2,0,255);
          }
        }
      }
      ready({size,pixels});
    };
    art.src=source;
  }

  const vertex=`
    attribute vec2 a;
    varying vec2 uv;
    void main(){
      uv=vec2(a.x,1.0-a.y);
      gl_Position=vec4(a*2.0-1.0,0.0,1.0);
    }`;
  const fragment=`
    precision highp float;
    varying vec2 uv;
    uniform samplerCube continents;
    uniform sampler2D fabric;
    uniform sampler2D snowMap;
    uniform sampler2D grainMap;
    uniform sampler2D reliefMap;
    uniform mat3 orientation;
    uniform vec3 sphere;
    uniform vec3 sun;
    void main(){
      vec2 p=(uv-sphere.xy)/sphere.z;
      p.y=-p.y;
      float distance=dot(p,p);
      if (distance>=1.0) {gl_FragColor=vec4(0.0);return;}
      float z=sqrt(1.0-distance);
      vec3 normal=vec3(p,z);
      vec3 world=orientation*normal;
      vec3 cloth=textureCube(continents,world).rgb;
      float land=cloth.r;
      vec3 shift=orientation*vec3(-.006,.007,0.0);
      float raised=land*(1.0-textureCube(continents,world+shift).r);
      float back=textureCube(continents,world-shift*2.1).r;
      float shadow=(1.0-land)*back;
      float lip=land*(1.0-textureCube(continents,world+shift*2.6).r);
      float fold=land*(1.0-back);
      vec3 weight=world*world;
      weight*=weight;
      weight/=weight.x+weight.y+weight.z;
      vec3 weave=world*1.96;
      vec2 thread=texture2D(fabric,weave.yz+.32).rg*weight.x
                 +texture2D(fabric,weave.zx+.65).rg*weight.y
                 +texture2D(fabric,weave.xy).rg*weight.z;
      float fiber=mix(thread.r,thread.g,land)-.5;
      vec3 ocean=vec3(.19,.43,.43);
      vec3 felt=mix(vec3(.49,.60,.40),vec3(.86,.73,.50),cloth.b);
      vec3 color=mix(ocean,felt,land)+fiber*vec3(.49,.51,.42);
      float light=max(0.0,dot(normal,vec3(-.48,.43,.76)));
      color*=.41+.89*light;
      color+=vec3(.075,.055,.023)*light*light;
      color+=vec3(.12,.095,.05)*lip;
      color*=1.0-.14*fold;
      color+=vec3(.22,.17,.08)*raised*(.45+.55*light);
      color*=1.0-.29*shadow;
      float rim=pow(1.0-z,5.0)*light;
      color+=rim*vec3(.42,.31,.15);
      float stitches=cloth.g;
      color+=stitches*vec3(.22,.19,.11)*(.52+.54*light);
      float nap=texture2D(fabric,world.xy*5.7+world.z*.63).g-.5;
      color+=nap*vec3(.11,.105,.085);
      vec2 snowUV=vec2(atan(world.x,world.z)/6.2831853+.5,.5-asin(clamp(world.y,-1.0,1.0))/3.14159265);
      float snow=texture2D(snowMap,snowUV).r*land;
      vec2 tile=snowUV*vec2(18.0,8.0);
      float height=texture2D(grainMap,tile).r;
      float edge=texture2D(grainMap,tile+vec2(.012,.014)).r-height;
      float loft=smoothstep(.03,.82,height+edge*1.35+nap*.23);
      vec3 powder=mix(vec3(.84,.88,.92),vec3(1.0,.999,.995),loft);
      float fringe=smoothstep(.015,.91,snow+(height-.55)*.34*min(1.0,snow*8.0))*land;
      float slope=(texture2D(reliefMap,snowUV+vec2(.000977,.001953)).r
                  -texture2D(reliefMap,snowUV-vec2(.000977,.001953)).r)*8.0;
      float relief=1.0+.095*clamp(slope,-1.0,1.0);
      color=mix(color,powder*(.88+.15*light)*relief+edge*.08,fringe);
      float altitude=dot(world,sun);
      float day=smoothstep(-.34,.27,altitude);
      color=mix(color*vec3(.33,.41,.64)+vec3(.015,.024,.066),color,day);
      color+=vec3(.066,.033,.012)*4.0*day*(1.0-day);
      float alpha=1.0-smoothstep(.989,1.0,distance);
      gl_FragColor=vec4(color,alpha);
    }`;

  // A seasonal illustration, in geographic coordinates shared by both renderers.
  function snowField(){
    const width=1024,height=512,pixels=new Uint8Array(width*height);
    const field={width,height,pixels,revision:0};
    let day=-1;
    field.update=date=>{
      const stamp=Math.floor(date.getTime()/86400000);
      if(stamp===day)return;
      day=stamp;
      const winter=Math.cos(2*Math.PI*(date-Date.UTC(date.getUTCFullYear(),0,20))/31557600000);
      for(let y=0;y<height;y++){
        const lat=90-(y+.5)*180/height;
        const season=lat>=0?winter:-winter;
        for(let x=0;x<width;x++){
          const lon=(x+.5)*360/width-180;
          const inland=lat>0?(4*Math.cos((lon-95)*rad*2)-2*Math.cos(lon*rad)):0;
          const variation=2*Math.sin((lon+lat)*.17)+1.6*Math.cos((lon-lat)*.29);
          const plain=(Math.abs(lat)-65+15*season+inland+variation)/6;
          // Seasonal illustration: near the tropics the snow line stays high year round.
          const elevation=window.RouteElevation[y*width+x]*32;
          const snowLine=Math.max(200,5200-43*Math.abs(lat)
            -(1+season)*1775*Math.sin(Math.abs(lat)*rad)-inland*38);
          const alpine=clamp((elevation-snowLine+380)/820,0,1);
          const depth=Math.max(plain,alpine*alpine*(3-2*alpine));
          const fringe=.16*Math.sin(lon*1.4+Math.sin(lat))*Math.cos(lat*1.9);
          pixels[y*width+x]=Math.round(255*clamp(depth+fringe*4*clamp(depth,0,1)*(1-clamp(depth,0,1)),0,1));
        }
      }
      field.base=pixels.slice();field.worn=false;
      field.revision++;
    };
    // Brushed snow slowly settles back to the seasonal cover.
    field.regrow=step=>{
      if(!field.worn || !field.base)return false;
      let left=false;
      for(let i=0;i<pixels.length;i++){
        if(pixels[i]>=field.base[i])continue;
        pixels[i]=Math.min(field.base[i],pixels[i]+step);
        if(pixels[i]<field.base[i])left=true;
      }
      field.worn=left;field.revision++;
      return true;
    };
    field.erase=(n,radius)=>{
      const lat=Math.asin(clamp(n[1],-1,1)),lon=Math.atan2(n[0],n[2]);
      const cx=(lon/Math.PI+1)*width/2-.5,cy=(.5-lat/Math.PI)*height-.5;
      const ry=radius*height/Math.PI,rx=Math.min(width/2,ry/Math.max(.025,Math.cos(lat)));
      let changed=false;
      for(let y=Math.max(0,Math.floor(cy-ry));y<=Math.min(height-1,Math.ceil(cy+ry));y++){
        for(let x=Math.floor(cx-rx);x<=Math.ceil(cx+rx);x++){
          const distance=Math.hypot((x-cx)/rx,(y-cy)/ry);
          if(distance>=1)continue;
          const i=y*width+(x+width)%width;
          const next=Math.min(pixels[i],Math.round(255*clamp((distance-.72)/.28,0,1)));
          if(next!==pixels[i]){pixels[i]=next;changed=true}
        }
      }
      if(changed){field.revision++;field.worn=true}
    };
    return field;
  }

  function gpu(canvas,sample) {
    const gl=canvas.getContext("webgl",{alpha:true,premultipliedAlpha:false,antialias:false,powerPreference:"low-power"});
    if (!gl) return null;
    const program=gl.createProgram();
    for (const [type,code] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
      const shader=gl.createShader(type);
      gl.shaderSource(shader,code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) return null;
      gl.attachShader(program,shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program,gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,"a");
    gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    gl.enableVertexAttribArray(position);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP,gl.createTexture());
    gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    landCube(gl,sample);
    gl.uniform1i(gl.getUniformLocation(program,"continents"),0);

    gl.activeTexture(gl.TEXTURE1);
    const fabric=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,fabric);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([128,128,255,255]));
    gl.uniform1i(gl.getUniformLocation(program,"fabric"),1);
    gl.viewport(0,0,canvas.width,canvas.height);
    const solarUniform=gl.getUniformLocation(program,"sun");
    const orientation=gl.getUniformLocation(program,"orientation");
    gl.uniform3f(gl.getUniformLocation(program,"sphere"),sphere.x,sphere.y,sphere.r);
    gl.activeTexture(gl.TEXTURE2);
    const snowTexture=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,snowTexture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program,"snowMap"),2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,256,256,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,window.RoutePowder);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform1i(gl.getUniformLocation(program,"grainMap"),3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,1024,512,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,window.RouteElevation);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program,"reliefMap"),4);
    let snowRevision=-1,uploaded=null;
    return (camera,felt,sun,snow) => {
      if (felt && felt!==uploaded) {
        const {size,pixels}=felt;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D,fabric);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,size,size,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        uploaded=felt;
      }
      if(snowRevision!==snow.revision){
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,snowTexture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,snow.width,snow.height,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,snow.pixels);
        snowRevision=snow.revision;
      }
      gl.uniformMatrix3fv(orientation,false,camera);
      gl.uniform3fv(solarUniform,sun);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    };
  }

  function software(canvas,sample) {
    const size=canvas.width=canvas.height=384;
    const ctx=canvas.getContext("2d");
    const buffer=ctx.createImageData(size,size);
    const screen=Array.from({length:size},(_,y)=>{
      const up=(sphere.y-(y+.5)/size)/sphere.r;
      const row=[];
      for (let x=0; x<size; x++) {
        const right=((x+.5)/size-sphere.x)/sphere.r, distance=right*right+up*up;
        if (distance>=1) continue;
        row.push([4*(y*size+x),right,up,Math.sqrt(1-distance),clamp((1-distance)*92,0,1)]);
      }
      return row;
    }).flat();
    return (camera,felt,sun,snow) => {
      const data=buffer.data;
      const tile = felt?.size || 1;
      const coord=(value,offset=0) => {
        const shifted=value*1.96+offset;
        return Math.floor((shifted-Math.floor(shifted))*tile);
      };
      for (const [index,right,up,depth,alpha] of screen) {
        const x=right*camera[0]+up*camera[3]+depth*camera[6];
        const y=right*camera[1]+up*camera[4]+depth*camera[7];
        const z=right*camera[2]+up*camera[5]+depth*camera[8];
        const mask=sample(x,y,z),land=(mask&255)/255;
        const len=Math.hypot(right-.006,up+.007,depth);
        const shifted=(sample((x-.006*camera[0]+.007*camera[3])/len,(y-.006*camera[1]+.007*camera[4])/len,(z-.006*camera[2]+.007*camera[5])/len)&255)/255;
        const side=(scale)=>{
          const length=Math.hypot(right-scale*.006,up+scale*.007,depth);
          return (sample((x+scale*(-.006*camera[0]+.007*camera[3]))/length,
                         (y+scale*(-.006*camera[1]+.007*camera[4]))/length,
                         (z+scale*(-.006*camera[2]+.007*camera[5]))/length)&255)/255;
        };
        const back=side(-2.1),lip=land*(1-side(2.6));
        const raised=land*(1-shifted),shadow=(1-land)*back,fold=land*(1-back);
        const patch=(mask>>16)/255;
        const stitch=((mask>>8)&255)/255;
        const light=Math.max(0,depth*.76-right*.48+up*.43);
        const illumination=.41+.89*light;
        let fiber=0;
        if (felt) {
          const tone=(col,row) => {
            const i=4*(row*tile+col);
            return (felt.pixels[i]*(1-land)+felt.pixels[i+1]*land)/255-.5;
          };
          const a=x**4,b=y**4,c=z**4;
          fiber=(tone(coord(y,.32),coord(z,.32))*a+tone(coord(z,.65),coord(x,.65))*b+tone(coord(x),coord(y))*c)/(a+b+c);
        }
        const rim=(1-depth)**5*light;
        data[index]=(48.5+(76.5+94*patch)*land+125*fiber)*illumination+107*rim+19*light*light+31*lip;
        data[index+1]=(109.7+(43.3+33*patch)*land+130*fiber)*illumination+79*rim+14*light*light+24*lip;
        data[index+2]=(109.7+(-7.7+25*patch)*land+107*fiber)*illumination+38*rim+6*light*light+13*lip;
        const edge=raised*(.45+.55*light)+stitch*(.52+.54*light);
        data[index]=(data[index]+56*edge)*(1-.29*shadow)*(1-.14*fold);
        data[index+1]=(data[index+1]+46*edge)*(1-.29*shadow)*(1-.14*fold);
        data[index+2]=(data[index+2]+25*edge)*(1-.29*shadow)*(1-.14*fold);
        if(land){
          const col=Math.floor((Math.atan2(x,z)/(2*Math.PI)+.5)*snow.width)%snow.width;
          const row=clamp(Math.floor((.5-Math.asin(clamp(y,-1,1))/Math.PI)*snow.height),0,snow.height-1);
          const amount=snow.pixels[row*snow.width+col]/255*land;
          if(amount>0){
            const u=Math.floor((Math.atan2(x,z)/(2*Math.PI)+.5)*4608);
            const v=Math.floor((.5-Math.asin(clamp(y,-1,1))/Math.PI)*2048);
            const grain=(a,b)=>window.RoutePowder[(b&255)*256+(a&255)]/255;
            const height=grain(u,v),edge=grain(u+3,v+4)-height;
            const t=clamp((height+edge*1.35+fiber*.12-.03)/.79,0,1);
            const loft=t*t*(3-2*t);
            const f=clamp((amount+(height-.55)*.34*Math.min(1,amount*8)-.015)/.895,0,1);
            const elev=(dx,dy)=>window.RouteElevation[clamp(row+dy,0,snow.height-1)*snow.width+(col+dx+snow.width)%snow.width];
            const relief=1+.095*clamp((elev(1,1)-elev(-1,-1))*8/255,-1,1);
            const cover=f*f*(3-2*f)*land,lit=(.88+.15*light)*relief*255;
            for(const [k,base,white] of [[0,.84,1],[1,.88,.999],[2,.92,.995]]){
              const powder=base+(white-base)*loft;
              data[index+k]=data[index+k]*(1-cover)+(powder*lit+edge*20)*cover;
            }
          }
        }
        const altitude=x*sun[0]+y*sun[1]+z*sun[2], t=clamp((altitude+.34)/.61,0,1);
        const day=t*t*(3-2*t), night=1-day, dusk=4*day*night;
        data[index]=data[index]*(day+.33*night)+3.8*night+16.83*dusk;
        data[index+1]=data[index+1]*(day+.41*night)+6.1*night+8.415*dusk;
        data[index+2]=data[index+2]*(day+.64*night)+16.8*night+3.1*dusk;
        data[index+3]=255*alpha;
      }
      ctx.putImageData(buffer,0,0);
    };
  }

  function create(element,markers,placeActors,now=()=>new Date()) {
    const sample=landMask();
    const overlay=markers.getContext("2d");
    let camera=home, zoom=1;
    let canvas=element, paint, felt;
    const detail=Math.min(1536,Math.max(768,Math.round(canvas.clientWidth*(window.devicePixelRatio||1)*1.5)));
    canvas.width=canvas.height=detail;
    try { paint=gpu(canvas,sample); } catch {}
    function fallback() {
      const replacement=canvas.cloneNode(false);
      canvas.replaceWith(replacement);
      canvas=replacement;
      paint=software(canvas,sample);
    }
    if (!paint) fallback();
    else canvas.addEventListener("webglcontextlost",event => {
      event.preventDefault();
      fallback();
      schedule();
    },{once:true});

    function worldAt(u,v){
      const radius=sphere.r*zoom;
      const a=(u-sphere.x)/radius,b=(sphere.y-v)/radius,r2=a*a+b*b;
      if(r2>=1)return null;
      const z=Math.sqrt(1-r2);
      return [0,1,2].map(i=>a*camera[i]+b*camera[i+3]+z*camera[i+6]);
    }
    const snow=snowField();
    const scene=canvas.closest(".scene");
    let cleaning=false,stroke=null,entry=null,exitTap=null,blockClick=false;
    function setCleaning(on,u,v){
      cleaning=on;stroke=null;exitTap=null;lastTap=null;
      entry=on?{u,v}:null;
      scene.classList.toggle("brushing-snow",on);
    }
    {
      const sweep=e=>{
        const box=scene.getBoundingClientRect();
        const u=(e.clientX-box.left)/box.width,v=(e.clientY-box.top)/box.height;
        const steps=Math.ceil(Math.hypot(u-stroke.u,v-stroke.v)*50)+1;
        for(let i=1;i<=steps;i++){
          const n=worldAt(stroke.u+(u-stroke.u)*i/steps,stroke.v+(v-stroke.v)*i/steps);
          if(n && (sample(...n)&255)>128)snow.erase(n,.073/zoom);
        }
        stroke.u=u;stroke.v=v;schedule();
      };
      for(const kind of ["pointerdown","pointermove","pointerup","pointercancel","lostpointercapture","click","dblclick"]){
        scene.addEventListener(kind,e=>{
          if(e.target.closest("button") && !stroke)return;
          if(kind==="click" && blockClick){e.stopImmediatePropagation();blockClick=false;return}
          if(!cleaning)return;
          e.stopImmediatePropagation();if(e.cancelable)e.preventDefault();
          if(kind==="pointerdown" && e.button===0 && !stroke){
            const box=scene.getBoundingClientRect(),u=(e.clientX-box.left)/box.width,v=(e.clientY-box.top)/box.height;
            if(!worldAt(u,v)){exitTap=null;return}
            stroke={id:e.pointerId,u,v,x:e.clientX,y:e.clientY,moved:false};
            scene.setPointerCapture(e.pointerId);
          }else if(stroke && stroke.id===e.pointerId){
            if(kind==="pointermove" && (stroke.moved || Math.hypot(e.clientX-stroke.x,e.clientY-stroke.y)>5)){
              stroke.moved=true;exitTap=null;sweep(e);
            }
            if(kind==="pointerup"){
              const box=scene.getBoundingClientRect(),u=(e.clientX-box.left)/box.width,v=(e.clientY-box.top)/box.height;
              if(!stroke.moved && worldAt(u,v) && box.width*Math.hypot(u-entry.u,v-entry.v)>18){
                if(exitTap && e.timeStamp-exitTap.time<=420 && Math.hypot(e.clientX-exitTap.x,e.clientY-exitTap.y)<=18){
                  setCleaning(false);blockClick=true;
                }else exitTap={x:e.clientX,y:e.clientY,time:e.timeStamp};
              }else exitTap=null;
            }
            if(kind==="pointerup" || kind==="pointercancel" || kind==="lostpointercapture")stroke=null;
          }
        },true);
      }
    }
    const crab=canvas.closest(".scene").querySelector("#crab-anchor");
    let oceanSpot=null,crabShift=[0,0];
    // Each dive ends the cycle: the crab rests for a random pause and surfaces elsewhere.
    crab?.querySelector(".crab-body").addEventListener("animationiteration",event=>{
      if(event.animationName!=="ocean-visit")return;
      crab.style.setProperty("--crab-cycle",(7+Math.random()*3).toFixed(1)+"s");
      crab.style.setProperty("--crab-pause",(Math.random()*9).toFixed(1)+"s");
      crab.classList.add("crab-rest");void crab.offsetWidth;crab.classList.remove("crab-rest");
      crabShift=[Math.floor(Math.random()*10),Math.floor(Math.random()*9)];
      oceanSpot=null;schedule();
    });
    function positionCrab(point){
      if(!crab)return;
      if(oceanSpot){
        const [x,y,z]=point(...oceanSpot);
        if(z>.30 && x>.09 && x<.91 && y>.12 && y<.91){
          crab.style.left=x*100+"%";crab.style.top=y*100+"%";return;
        }
        oceanSpot=null;
      }
      crab.hidden=true;
      for(let row=0;row<9;row++)for(let col=0;col<10;col++){
        const u=.18+((col+2+crabShift[0])%10)*.07,v=.22+((row+5+crabShift[1])%9)*.07;
        const offsets=[[0,0],[-.035,0],[.035,0],[0,-.027],[-.025,-.022],[.025,-.022]];
        if(!offsets.every(([dx,dy])=>{
          const n=worldAt(u+dx,v+dy);
          return n && dot(n,camera.slice(6))>.34 && (sample(...n)&255)<16;
        }))continue;
        const n=worldAt(u,v);
        oceanSpot=[Math.asin(clamp(n[1],-1,1))/rad,Math.atan2(n[0],n[2])/rad];
        crab.style.left=u*100+"%";crab.style.top=v*100+"%";
        crab.hidden=false;return;
      }
    }
    // Surface feedback uses its own transparent layer; ripples never repaint the terrain.
    const effects=document.createElement("canvas");
    effects.className=markers.className;
    effects.width=markers.width; effects.height=markers.height;
    effects.setAttribute("aria-hidden","true");
    effects.style.pointerEvents="none";
    markers.before(effects);
    const ink=effects.getContext("2d");
    let traces=[], effectFrame=0, lastTap=null;
    function surfaceTap(u,v){
      const n=worldAt(u,v);
      if(!n){lastTap=null;return}
      const time=performance.now(), width=markers.getBoundingClientRect().width;
      const crater=lastTap && time-lastTap.time<=420 && lastTap.camera===camera && lastTap.zoom===zoom &&
        width*Math.hypot(u-lastTap.u,v-lastTap.v)<=18;
      if(crater)traces=traces.filter(trace=>trace!==lastTap.trace);
      const east=unit(cross(Math.abs(n[1])>.999?[0,0,1]:[0,1,0],n));
      const land=(sample(...n)&255)>=128;
      if(crater && land){
        const col=Math.floor((Math.atan2(n[0],n[2])/(2*Math.PI)+.5)*snow.width)%snow.width;
        const row=clamp(Math.floor((.5-Math.asin(clamp(n[1],-1,1))/Math.PI)*snow.height),0,snow.height-1);
        if(snow.pixels[row*snow.width+col]>48){setCleaning(true,u,v);return}
      }
      const still=document.documentElement.classList.contains("still") ||
        matchMedia("(prefers-reduced-motion:reduce)").matches;
      const trace={n,east,north:cross(n,east),land,still,time,crater:!!crater,life:crater?8000:(land?4800:1550)};
      traces.push(trace);
      lastTap=crater?null:{u,v,time,camera,zoom,trace};
      if(traces.length>16)traces.shift();
      if(!effectFrame)effectFrame=requestAnimationFrame(drawTraces);
    }
    function drawCrater(trace,elapsed){
      const impact=trace.still?1:Math.min(1,elapsed/580);
      ink.save();
      const growth=.55+.45*Math.min(1,impact*4);
      ink.scale(growth,growth);
      // Uneven felt lip with a bright inner wall opposite the raised edge.
      const pit=ink.createRadialGradient(-1,-2,1,0,0,9);
      pit.addColorStop(0,trace.land?"#453c38":"#173d4b");
      pit.addColorStop(.66,trace.land?"#65534a":"#345e62");
      pit.addColorStop(.84,trace.land?"#bc9970":"#82b9b1");
      pit.addColorStop(1,trace.land?"#806851":"#466e71");
      ink.fillStyle=pit;ink.beginPath();
      for(let i=0;i<=48;i++){
        const a=i*Math.PI/24, r=8.8+.55*Math.sin(3*a)+.34*Math.cos(5*a);
        const x=Math.cos(a)*r,y=Math.sin(a)*r;
        if(i===0)ink.moveTo(x,y);else ink.lineTo(x,y);
      }
      ink.closePath();ink.fill();ink.restore();
      if(impact>=1)return;
      ink.save();ink.globalAlpha*=1-impact;
      if(impact<.42){
        ink.fillStyle="#ffe5a0";ink.beginPath();ink.arc(0,0,6*(1-impact/.42),0,Math.PI*2);ink.fill();
      }
      for(let i=0;i<10;i++){
        const a=i*2.4, reach=(10+(i%4)*2)*impact;
        const x=Math.cos(a)*(5+reach),y=Math.sin(a)*(5+reach)-12*Math.sin(Math.PI*impact);
        ink.fillStyle=i%3===0?"#ffcd81":trace.land?"#b28b68":"#a5d5d1";
        ink.beginPath();ink.arc(x,y,1.7-impact,0,Math.PI*2);ink.fill();
      }
      ink.restore();
    }
    function drawTraces(time){
      effectFrame=0;
      const w=effects.width,scale=w*sphere.r*zoom;
      ink.clearRect(0,0,w,w);
      traces=traces.filter(t=>time-t.time<t.life);
      if(!traces.length)return;
      const right=camera.slice(0,3),up=camera.slice(3,6),front=camera.slice(6);
      ink.save();
      ink.beginPath();ink.arc(w*sphere.x,w*sphere.y,scale,0,2*Math.PI);ink.clip();
      for(const t of traces){
        const depth=dot(t.n,front);
        if(depth<=0)continue;
        const age=(time-t.time)/t.life;
        ink.save();
        ink.translate(w*sphere.x+scale*dot(t.n,right),w*sphere.y-scale*dot(t.n,up));
        ink.transform(dot(t.east,right),-dot(t.east,up),-dot(t.north,right),dot(t.north,up),0,0);
        const sz=scale/240; ink.scale(sz,sz);
        ink.globalAlpha=clamp(depth*10,0,1)*((t.crater||t.land)?Math.min(1,(1-age)*3):1-age);
        if(t.crater){
          drawCrater(t,time-t.time);
        }else if(t.land){
          ink.rotate(-.25);
          // A toe and heel leave a small paired impression in the felt.
          for(const [x,y,tilt] of [[-3,3,-.12],[3,-3,.12]]){
            ink.save();ink.translate(x,y);ink.rotate(tilt);
            ink.fillStyle="#654634";ink.strokeStyle="#e2c493";ink.lineWidth=.8;
            for(const [cy,rx,ry] of [[-1.8,2.15,3.35],[3.2,1.55,1.45]]){
              ink.beginPath();ink.ellipse(0,cy,rx,ry,0,0,2*Math.PI);ink.fill();ink.stroke();
            }
            ink.restore();
          }
        }else{
          for(const delay of [0,.22,.44]){
            const progress=(t.still?.68:age)-delay;
            if(progress<0)continue;
            const radius=2+23*progress;
            ink.beginPath();ink.arc(0,0,radius,0,2*Math.PI);
            ink.strokeStyle="#194e5c";ink.lineWidth=2;ink.stroke();
            ink.strokeStyle="#c4ece3";ink.lineWidth=.95;ink.stroke();
          }
        }
        ink.restore();
      }
      ink.restore();
      effectFrame=requestAnimationFrame(drawTraces);
    }
    // Decorative layer under the labels: cotton clouds, night lights, the stitched route,
    // the Prince's shadow, lint from his landing and snowflakes.
    const decor=document.createElement("canvas");
    decor.className=markers.className;
    decor.width=markers.width; decor.height=markers.height;
    decor.setAttribute("aria-hidden","true");
    decor.style.pointerEvents="none";
    effects.before(decor);
    const pen=decor.getContext("2d");
    const calm=()=>document.documentElement.classList.contains("still") ||
      matchMedia("(prefers-reduced-motion:reduce)").matches;
    const spot=n=>{
      const [x,y,z]=project(camera,Math.asin(clamp(n[1],-1,1))/rad,Math.atan2(n[0],n[2])/rad);
      return [sphere.x+(x-sphere.x)*zoom,sphere.y+(y-sphere.y)*zoom,z];
    };
    const slerp=(a,b,t)=>{
      const angle=Math.acos(clamp(dot(a,b),-1,1));
      if(angle<1e-4)return a;
      const p=Math.sin((1-t)*angle)/Math.sin(angle),q=Math.sin(t*angle)/Math.sin(angle);
      return [0,1,2].map(i=>a[i]*p+b[i]*q);
    };
    const towns=[[40.7,-74],[34,-118.2],[19.4,-99.1],[-23.5,-46.6],[-34.6,-58.4],[51.5,-.1],[48.9,2.3],[52.5,13.4],
      [41.9,12.5],[40.4,-3.7],[55.75,37.6],[41,29],[30,31.2],[6.5,3.4],[-26.2,28],[25.2,55.3],[28.6,77.2],[19.1,72.9],
      [13.75,100.5],[1.35,103.8],[39.9,116.4],[31.2,121.5],[35.7,139.7],[37.6,127],[-33.9,151.2],[-6.2,106.8],
      [43.65,-79.4],[41.9,-87.6],[59.3,18.1],[50.45,30.5]].map(([lat,lon])=>direction(lat,lon));
    const clouds=[[58,-30,1.1],[34,-52,.9],[12,62,1],[-8,-18,1.2],[47,150,.9],[-28,80,1.1],[66,60,.8]]
      .map(([lat,lon,scale],i)=>({lat,lon,scale,seed:i*1.7}));
    const puffs=[[-1.1,.1,.8],[0,-.25,1.05],[1.05,.12,.85],[.2,.3,.95]];
    let show={phase:"home",place:"",prince:null}, thread=null, lint=[], flakes=[], aloft=false;
    let decorFrame=0, decorLast=0, flakeLast=0;
    function stage(next){
      Object.assign(show,next);
      const place=locations[show.place];
      if(show.phase==="home" || !place){
        if(thread && !thread.fade)thread.fade=performance.now();
      }else if(!thread || thread.place!==show.place || thread.fade){
        const to=direction(place.lat,place.lon);
        const from=thread && !thread.fade && thread.progress>.5 ? thread.to
          : (worldAt(sphere.x,sphere.y+sphere.r*zoom*.93) || direction(place.lat-38,place.lon-8));
        thread={place:show.place,from,to,progress:calm()?1:0,fade:0};
      }
    }
    function drawDecor(ts){
      const size=decor.width, px=size/430, still=calm(), time=ts/1000, sun=sunlight(now());
      pen.clearRect(0,0,size,decor.height);
      for(const cloud of clouds){
        const n=direction(cloud.lat+2.5*Math.sin(time*.05+cloud.seed),cloud.lon+(still?0:time*.35));
        const [x,y,z]=spot(n);
        if(z<.16)continue;
        const day=clamp(dot(n,sun)*3+.55,.25,1), r=size*.021*cloud.scale*zoom*(.5+.5*z);
        const puff=(dx,dy,k,fill)=>{
          pen.beginPath();pen.ellipse(x*size+dx*r,y*size+dy*r,r*k,r*k*.72,0,0,2*Math.PI);
          pen.fillStyle=fill;pen.fill();
        };
        pen.globalAlpha=clamp((z-.16)/.2,0,1);
        for(const [dx,dy,k] of puffs)puff(dx+.5,dy+.9,k,"rgba(12,30,34,.16)");
        const tone=Math.round(255*day);
        for(const [dx,dy,k] of puffs)puff(dx,dy,k,"rgba("+tone+","+Math.round(tone*.985)+","+Math.round(tone*.95)+",.86)");
      }
      pen.globalAlpha=1;
      const glow=(n,strength,radius)=>{
        const night=clamp((.06-dot(n,sun))/.22,0,1)*strength;
        if(night<=.02)return;
        const [x,y,z]=spot(n);
        if(z<.08)return;
        const r=radius*px*zoom, light=pen.createRadialGradient(x*size,y*size,0,x*size,y*size,r);
        light.addColorStop(0,"rgba(255,224,150,"+(.95*night)+")");
        light.addColorStop(.35,"rgba(255,190,100,"+(.45*night)+")");
        light.addColorStop(1,"rgba(255,170,80,0)");
        pen.fillStyle=light;pen.beginPath();pen.arc(x*size,y*size,r,0,2*Math.PI);pen.fill();
      };
      for(const n of towns)glow(n,.8,4.2);
      for(const key in locations){
        const active=key===show.place && show.phase!=="home";
        const flicker=active && !still ? .78+.22*Math.sin(time*5.3+2*Math.sin(time*1.9)) : 1;
        glow(direction(locations[key].lat,locations[key].lon),flicker,active?10:6.5);
      }
      if(thread){
        const linked=show.phase==="connected", goal=linked?1:.9;
        if(!thread.fade)thread.progress=still?1:Math.min(goal,thread.progress+(goal-thread.progress)*(linked?.2:.035)+.002);
        const fade=thread.fade?1-(ts-thread.fade)/700:1;
        if(fade<=0)thread=null;
        else{
          const angle=Math.acos(clamp(dot(thread.from,thread.to),-1,1)), steps=Math.max(6,Math.round(angle/rad/1.5));
          const reach=thread.progress*steps;
          pen.lineCap="round";
          for(const [color,width,drop] of [["rgba(30,22,14,.38)",3.3,1.1],["#f7e6bd",2.1,0]]){
            pen.strokeStyle=color;pen.lineWidth=width*px;pen.globalAlpha=fade*(linked?.9:1);
            for(let i=0;i<steps && i<reach;i+=2){
              const a=spot(slerp(thread.from,thread.to,i/steps));
              const b=spot(slerp(thread.from,thread.to,Math.min(i+1.15,reach)/steps));
              if(a[2]<.07 || b[2]<.07)continue;
              pen.beginPath();pen.moveTo(a[0]*size,a[1]*size+drop*px);pen.lineTo(b[0]*size,b[1]*size+drop*px);pen.stroke();
            }
          }
          if(thread && thread.progress<.995 && !thread.fade){
            const [x,y,z]=spot(slerp(thread.from,thread.to,thread.progress));
            if(z>.07){pen.globalAlpha=1;pen.fillStyle="#fff6d8";pen.beginPath();pen.arc(x*size,y*size,2.6*px,0,2*Math.PI);pen.fill();}
          }
          pen.globalAlpha=1;
        }
      }
      const prince=show.prince;
      if(prince){
        const [x,y,z]=spot(direction(prince.lat,prince.lon)), lift=prince.lift||0;
        if(z>.06){
          const r=11*px*Math.min(1.45,Math.sqrt(zoom))*(.76+.24*z)*(1-.42*lift);
          pen.fillStyle="rgba(10,22,20,"+(.34*(1-.55*lift))+")";
          pen.beginPath();pen.ellipse(x*size-px,y*size+.5*px,r,r*.36,0,0,2*Math.PI);pen.fill();
          if(aloft && lift<=.02 && !still)for(let i=0;i<10;i++){
            const a=Math.PI*(1+i/9)+(Math.random()-.5)*.3;
            lint.push({x:x*size,y:y*size,vx:Math.cos(a)*(14+Math.random()*16)*px,vy:Math.sin(a)*(5+Math.random()*9)*px,
              born:ts,turn:Math.random()*6,tone:i%3});
          }
        }
        aloft=lift>.02;
      }
      lint=lint.filter(fibre=>ts-fibre.born<560);
      for(const fibre of lint){
        const age=(ts-fibre.born)/560, ease=1-(1-age)*(1-age), c=fibre.turn+age*3;
        const fx=fibre.x+fibre.vx*ease, fy=fibre.y+fibre.vy*ease+10*px*age*age;
        pen.globalAlpha=(1-age)*.85;pen.strokeStyle=["#efe3c2","#b9cf9a","#d9c79c"][fibre.tone];pen.lineWidth=1.3*px;
        pen.beginPath();pen.moveTo(fx-Math.cos(c)*3*px,fy-Math.sin(c)*3*px);
        pen.quadraticCurveTo(fx+Math.sin(c)*2*px,fy-Math.cos(c)*2*px,fx+Math.cos(c)*3*px,fy+Math.sin(c)*3*px);pen.stroke();
      }
      pen.globalAlpha=1;
      if(still){flakes=[];return}
      if(flakes.length<22 && ts-flakeLast>110){
        flakeLast=ts;
        for(let attempt=0;attempt<8;attempt++){
          const u=sphere.x+(Math.random()*2-1)*sphere.r*zoom*.9, v=sphere.y+(Math.random()*2-1)*sphere.r*zoom*.9;
          const n=u>0 && u<1 && v>0 && v<1 ? worldAt(u,v) : null;
          if(!n || dot(n,camera.slice(6))<.22 || (sample(...n)&255)<128)continue;
          const col=Math.floor((Math.atan2(n[0],n[2])/(2*Math.PI)+.5)*snow.width)%snow.width;
          const row=clamp(Math.floor((.5-Math.asin(clamp(n[1],-1,1))/Math.PI)*snow.height),0,snow.height-1);
          if(snow.pixels[row*snow.width+col]<=105)continue;
          flakes.push({n,born:ts,life:2100+Math.random()*1500,sway:Math.random()*6,size:.9+Math.random()*.9});
          break;
        }
      }
      flakes=flakes.filter(flake=>ts-flake.born<flake.life);
      pen.fillStyle="#ffffff";
      for(const flake of flakes){
        const age=(ts-flake.born)/flake.life,[x,y,z]=spot(flake.n);
        if(z<.1)continue;
        pen.globalAlpha=Math.sin(Math.PI*Math.min(1,age*1.15))*.9;
        pen.beginPath();
        pen.arc(x*size+Math.sin(flake.sway+age*5)*3*px,y*size-(1-age)*15*px*zoom,flake.size*px,0,2*Math.PI);pen.fill();
      }
      pen.globalAlpha=1;
    }
    function decorTick(ts){
      decorFrame=0;
      if(document.hidden || !canvas.isConnected || calm())return;
      if(ts-decorLast>=33){decorLast=ts;drawDecor(ts);}
      decorFrame=requestAnimationFrame(decorTick);
    }
    setInterval(()=>{if(!document.hidden && !cleaning && snow.regrow(5))schedule();},2000);
    let cityButtons=[], frame=0;
    function render() {
      frame=0;
      const date=now();snow.update(date);
      paint(camera,felt,sunlight(date),snow);
      const point=(lat,lon)=>{
        const [x,y,z]=project(camera,lat,lon);
        return [sphere.x+(x-sphere.x)*zoom,sphere.y+(y-sphere.y)*zoom,z];
      };
      placeActors(point,zoom);
      positionCrab(point);
      drawDecor(performance.now());
      if(!decorFrame && !calm())decorFrame=requestAnimationFrame(decorTick);
      canvas.style.transformOrigin=markers.style.transformOrigin=(sphere.x*100)+"% "+(sphere.y*100)+"%";
      canvas.style.transform="scale("+zoom+")";
      if(felt)canvas.closest(".scene").classList.add("globe-ready");
      const size=markers.width;
      overlay.clearRect(0,0,size,size);
      for (const button of cityButtons) {
        const place=locations[button.dataset.place];
        const [x,y,depth]=point(place.lat,place.lon);
        button.hidden=depth<.09;
        if (button.hidden) continue;
        const selected=button.classList.contains("chosen");
        // The chosen city hosts the Prince: move its label clear of the figure.
        const clear=selected?Math.sign(place.offset[0])*.05:0;
        const labelX=clamp(x+place.offset[0]+clear,.13,.87);
        const labelY=clamp(y+place.offset[1],.10,.78);
        button.style.left=100*labelX+"%";
        button.style.top=100*labelY+"%";
        overlay.strokeStyle=selected?"#d4efa8":"#f1d4a6";
        overlay.lineWidth=1.35;
        overlay.beginPath();
        overlay.moveTo(x*size,y*size);
        overlay.lineTo(labelX*size,labelY*size);
        overlay.stroke();
        overlay.beginPath();
        overlay.arc(x*size,y*size,5.3,0,Math.PI*2);
        overlay.fillStyle=selected?"#d4efa8":"#f0c997";
        overlay.fill();
      }
    }
    function schedule() { if (!frame) frame=requestAnimationFrame(render); }
    function beginDrag(x,y) {
      const start=camera;
      const ball=(u,v)=>trackball(sphere.x+(u-sphere.x)/zoom,sphere.y+(v-sphere.y)/zoom);
      const from=ball(x,y);
      return (nextX,nextY) => {
        camera=turn(start,from,ball(nextX,nextY));
        schedule();
      };
    }
    let clockTimer;
    function syncClock(){
      clearTimeout(clockTimer);
      if(document.hidden || !canvas.isConnected)return;
      schedule();
      clockTimer=setTimeout(syncClock,60000-Date.now()%60000);
    }
    document.addEventListener("visibilitychange",syncClock);
    window.addEventListener("pageshow",syncClock);
    syncClock();
    feltTexture(texture => {felt=texture; schedule();});
    return {
      markers(buttons) {cityButtons=buttons; schedule();},
      refresh:schedule, beginDrag, surfaceTap, stage,
      rotate(dx,dy) {beginDrag(sphere.x,sphere.y)(sphere.x+dx,sphere.y+dy);},
      getZoom(){return zoom;},
      setZoom(next){zoom=clamp(next,1,2.6);schedule();},
      reset() {camera=home;zoom=1; schedule();},
    };
  }
  window.RouteGlobe={locations,create,sunlight,point:(lat,lon)=>project(home,lat,lon)};
})();
