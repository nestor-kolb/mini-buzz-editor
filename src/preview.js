'use strict';

const previewMotion = {
  amplitude: .72,
  bodyRange: .7,
  headRange: .7
};

class BuzzPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { alpha: true, antialias: true });
    this.context = this.gl ? null : canvas.getContext('2d');
    if (this.gl) this.initDepthRenderer();
    this.pose = initialPose();
    this.defaultView = { yaw: -.31, pitch: .16 };
    this.view = { ...this.defaultView };
    this.parts = this.build();
    this.bindOrbit();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const { clientWidth, clientHeight } = this.canvas;
    const pixelBudget = this.gl ? 950000 : 320000;
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(pixelBudget / (clientWidth * clientHeight)));
    const width = Math.round(clientWidth * ratio);
    const height = Math.round(clientHeight * ratio);
    if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.lastDraw = null;
      this.draw(this.pose);
    }
  }

  initDepthRenderer() {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, `
      attribute vec4 position;
      attribute vec3 shade;
      varying vec3 color;
      void main() { gl_Position = position; color = shade; }
    `));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec3 color;
      void main() { gl_FragColor = vec4(color, 1.0); }
    `));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    const stride = 7 * Float32Array.BYTES_PER_ELEMENT;
    for (const [name, size, offset] of [['position', 4, 0], ['shade', 3, 4]]) {
      const attribute = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
    }
    gl.enable(gl.DEPTH_TEST);
  }

  drawDepth(vertices, width, height) {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 7);
  }

  bindOrbit() {
    const canvas = this.canvas;
    const repaint = () => {
      if (this.orbitFrame) return;
      this.orbitFrame = requestAnimationFrame(() => {
        this.orbitFrame = null;
        this.draw(this.pose);
      });
    };
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.drag) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('orbiting');
    });
    canvas.addEventListener('pointermove', event => {
      if (this.drag?.id !== event.pointerId) return;
      this.view.yaw = (this.view.yaw + (event.clientX - this.drag.x) * .012) % (2 * Math.PI);
      this.view.pitch = Math.max(-.8, Math.min(.8, this.view.pitch + (event.clientY - this.drag.y) * .012));
      Object.assign(this.drag, { x: event.clientX, y: event.clientY });
      repaint();
    });
    canvas.addEventListener('lostpointercapture', event => {
      if (this.drag?.id !== event.pointerId) return;
      this.drag = null;
      canvas.classList.remove('orbiting');
    });
    canvas.addEventListener('dblclick', () => {
      this.view = { ...this.defaultView };
      repaint();
    });
  }

  build() {
    const colors = { green: [155, 227, 105], white: [221, 221, 240],
      dark: [51, 55, 78], purple: [166, 123, 228], skin: [255, 214, 176], red: [231, 103, 135] };
    const parts = [];
    const box = (joint, center, size, color, taper = 1) => {
      const [x, y, z] = center;
      const [w, h, d] = size.map(value => value / 2);
      const top = [[-w, -d], [w, -d], [w, d], [-w, d]];
      const vertices = [1, -1].flatMap(sign => top.map(([u, v]) =>
        [x + u * (sign === 1 ? taper : 1), y + sign * h, z + v]));
      const faces = [[0,3,2,1], [4,5,6,7], [0,1,5,4], [1,2,6,5], [2,3,7,6], [3,0,4,7]];
      parts.push({ joint, vertices, faces, color: colors[color] });
    };
    const helmet = (joint, center, scale) => {
      const sides = 8;
      const bands = 4;
      const vertices = [];
      const faces = [];
      for (let band = 0; band <= bands; band++) {
        const latitude = Math.PI * band / bands;
        for (let side = 0; side < sides; side++) {
          const angle = Math.PI * 2 * side / sides;
          vertices.push([
            center[0] + Math.sin(latitude) * Math.cos(angle) * scale[0],
            center[1] + Math.cos(latitude) * scale[1],
            center[2] + Math.sin(latitude) * Math.sin(angle) * scale[2]
          ]);
          if (band) {
            const a = (band - 1) * sides + side;
            const b = (band - 1) * sides + (side + 1) % sides;
            faces.push(band === 1 ? [a, b + sides, a + sides]
              : band === bands ? [a, b, a + sides] : [a, b, b + sides, a + sides]);
          }
        }
      }
      const faceColors = faces.map(face => {
        const front = face.reduce((sum, index) => sum + vertices[index][2], 0) / face.length;
        const height = face.reduce((sum, index) => sum + vertices[index][1], 0) / face.length;
        return colors[front > .13 && Math.abs(height - center[1]) < .22 ? 'skin' : 'purple'];
      });
      parts.push({ joint, vertices, faces, faceColors });
    };
    box('base', [0, -1.52, 0], [2.35, .39, 1.68], 'dark', .88);
    box('base', [0, -1.29, 0], [2.12, .12, 1.48], 'white', .94);
    for (const x of [-.29, .29]) {
      box('base', [x, -.97, 0], [.39, .49, .4], 'white', .86);
      box('base', [x, -1.16, .14], [.44, .17, .59], 'purple');
    }
    box('base', [0, -.65, 0], [.95, .28, .48], 'green', .92);
    box('waist', [0, -.38, 0], [.73, .24, .43], 'dark');
    box('waist', [0, -.04, 0], [.94, .52, .53], 'white', 1.20);
    box('waist', [0, .16, .02], [1.18, .34, .62], 'green', .91);
    box('waist', [0, .14, .33], [.57, .19, .06], 'white');
    box('waist', [-.14, .14, .37], [.09, .08, .025], 'purple');
    box('waist', [.02, .14, .37], [.07, .08, .025], 'red');
    for (const [joint, sign] of [['left', 1], ['right', -1]]) {
      const x = sign * .66;
      box('waist', [x, .21, 0], [.29, .25, .29], 'purple', .77);
      box(joint, [x, -.03, 0], [.28, .40, .27], 'white', .90);
      box(joint, [x, -.31, .02], [.29, .23, .31], 'green');
      box(joint, [x, -.49, .04], [.25, .23, .25], 'purple', .86);
    }
    helmet('head', [0, .72, 0], [.33, .41, .32]);
    for (const x of [-.085, .085]) box('head', [x, .76, .296], [.043, .026, .012], 'dark');
    box('head', [0, .63, .296], [.095, .023, .012], 'dark');
    return parts;
  }

  draw(pose) {
    this.pose = pose;
    const { width, height } = this.canvas;
    if (!width || !height) return;
    const values = [...pose.slice(0, Buzz.axes.length), this.view.yaw, this.view.pitch];
    if (this.lastDraw && values.every((value, index) => value === this.lastDraw[index])) return;
    this.lastDraw = values;
    const ctx = this.context;
    ctx?.clearRect(0, 0, width, height);
    const size = Math.min(width / 3.6, height / 3.65);
    const origin = [width / 2, height / 2 - size * .22];
    const rad = Math.PI / 180;
    const pitch = (angle, pivot) => {
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      return ([x, y, z]) => [x, pivot + (y - pivot) * cos - z * sin, (y - pivot) * sin + z * cos];
    };
    const yaw = angle => {
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      return ([x, y, z]) => [x * cos + z * sin, y, z * cos - x * sin];
    };
    const neutral = initialPose();
    const armPitch = index => {
      const minimum = Buzz.axes[index][1];
      const lift = Math.max(0, Math.min(1, (neutral[index] - pose[index]) / (neutral[index] - minimum)));
      return -lift * Math.PI / 2 * previewMotion.amplitude;
    };
    const joints = {
      left: pitch(armPitch(0), .21),
      right: pitch(armPitch(1), .21),
      head: pitch((neutral[2] - pose[2]) * rad * previewMotion.bodyRange * previewMotion.amplitude * previewMotion.headRange, .44)
    };
    const turnWaist = yaw((neutral[3] - pose[3]) * rad * previewMotion.bodyRange * previewMotion.amplitude);
    const turnView = yaw(this.view.yaw);
    const tiltView = pitch(this.view.pitch, 0);
    const transform = (point, joint) => {
      const posed = joints[joint] ? joints[joint](point) : point;
      return tiltView(turnView(joint === 'base' ? posed : turnWaist(posed)));
    };
    const project = ([x, y, z]) => {
      const scale = size * 7 / (7 - z);
      return [origin[0] + x * scale, origin[1] - y * scale];
    };
    const polygons = [];
    const triangles = [];
    const vertex = ([x, y, z], r, g, b) => {
      const w = 7 - z;
      triangles.push(x * size * 14 / width, y * size * 14 / height + (1 - 2 * origin[1] / height) * w,
        w - 2, w, r, g, b);
    };
    for (const { joint, vertices, faces, color, faceColors } of this.parts) {
      const points = vertices.map(point => transform(point, joint));
      const projected = ctx && points.map(project);
      for (let index = 0; index < faces.length; index++) {
        const face = faces[index];
        const [a, b, c] = [points[face[0]], points[face[1]], points[face[2]]];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nz * (7 - a[2]) - nx * a[0] - ny * a[1] <= 0) continue;
        const length = Math.hypot(nx, ny, nz);
        const light = .65 + .34 * Math.max(0, (-nx * .35 + ny * .53 + nz * .7) / length);
        const shade = faceColors?.[index] ?? color;
        if (this.gl) {
          const [r, g, b] = shade.map(value => value * light / 255);
          for (let corner = 1; corner < face.length - 1; corner++) {
            vertex(a, r, g, b);
            vertex(points[face[corner]], r, g, b);
            vertex(points[face[corner + 1]], r, g, b);
          }
        } else {
          polygons.push({ face, projected, depth: face.reduce((sum, vertex) => sum + points[vertex][2], 0) / face.length,
            color: shade, light });
        }
      }
    }
    if (this.gl) {
      this.drawDepth(triangles, width, height);
      return;
    }
    polygons.sort((a, b) => a.depth - b.depth);
    for (const { face, projected, color, light } of polygons) {
      ctx.beginPath();
      ctx.moveTo(...projected[face[0]]);
      for (let index = 1; index < face.length; index++) ctx.lineTo(...projected[face[index]]);
      ctx.closePath();
      ctx.fillStyle = 'rgb(' + color.map(value => Math.round(value * light)).join(',') + ')';
      ctx.fill();
    }
  }
}
