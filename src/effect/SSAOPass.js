var Matrix4 = require('qtek/lib/math/Matrix4');
var Vector3 = require('qtek/lib/math/Vector3');
var Texture2D = require('qtek/lib/Texture2D');
var Texture = require('qtek/lib/Texture');
var Pass = require('qtek/lib/compositor/Pass');
var Shader = require('qtek/lib/Shader');
var FrameBuffer = require('qtek/lib/FrameBuffer');
var halton = require('./halton');

Shader.import(require('./SSAO.glsl.js'));

function generateNoiseData(size) {
    var data = new Uint8Array(size * size * 4);
    var n = 0;
    var v3 = new Vector3();

    for (var i = 0; i < size; i++) {
        for (var j = 0; j < size; j++) {
            v3.set(Math.random() * 2 - 1, Math.random() * 2 - 1, 0).normalize();
            data[n++] = (v3.x * 0.5 + 0.5) * 255;
            data[n++] = (v3.y * 0.5 + 0.5) * 255;
            data[n++] = 0;
            data[n++] = 255;
        }
    }
    return data;
}

function generateNoiseTexture(size) {
    return new Texture2D({
        pixels: generateNoiseData(size),
        wrapS: Texture.REPEAT,
        wrapT: Texture.REPEAT,
        width: size,
        height: size
    });
}

function generateKernel(size, offset, hemisphere) {
    var kernel = new Float32Array(size * 3);
    offset = offset || 0;
    for (var i = 0; i < size; i++) {
        var phi = halton(i + offset, 2) * (hemisphere ? 1 : 2) * Math.PI;
        var theta = halton(i + offset, 3) * Math.PI;
        var r = Math.random();
        var x = Math.cos(phi) * Math.sin(theta) * r;
        var y = Math.cos(theta) * r;
        var z = Math.sin(phi) * Math.sin(theta) * r;

        kernel[i * 3] = x;
        kernel[i * 3 + 1] = y;
        kernel[i * 3 + 2] = z;
    }
    return kernel;

    // var kernel = new Float32Array(size * 3);
    // var v3 = new Vector3();
    // for (var i = 0; i < size; i++) {
    //     v3.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random())
    //         .normalize().scale(Math.random());
    //     kernel[i * 3] = v3.x;
    //     kernel[i * 3 + 1] = v3.y;
    //     kernel[i * 3 + 2] = v3.z;
    // }
    // return kernel;
}

function SSAOPass(opt) {
    opt = opt || {};

    this._ssaoPass = new Pass({
        fragment: Shader.source('ecgl.ssao.estimate')
    });
    this._blurPass = new Pass({
        fragment: Shader.source('ecgl.ssao.blur')
    });
    this._framebuffer = new FrameBuffer();
    
    this._ssaoTexture = new Texture2D();
    this._targetTexture = new Texture2D();

    this._depthTex = opt.depthTexture;
    this._normalTex = opt.normalTexture;

    this.setNoiseSize(4);
    this.setKernelSize(opt.kernelSize || 12);
    this.setParameter('blurSize', Math.round(opt.blurSize || 4));
    if (opt.radius != null) {
        this.setParameter('radius', opt.radius);
    }
    if (opt.power != null) {
        this.setParameter('power', opt.power);
    }

    if (!this._normalTex) {
        this._ssaoPass.material.shader.disableTexture('normalTex');
    }
}

SSAOPass.prototype.setDepthTexture = function (depthTex) {
    this._depthTex = depthTex;
};

SSAOPass.prototype.setNormalTexture = function (normalTex) {
    this._normalTex = normalTex;
    this._ssaoPass.material.shader[normalTex ? 'enableTexture' : 'disableTexture']('normalTex');
    // Switch between hemisphere and shere kernel.
    this.setKernelSize(this._kernelSize);
};

SSAOPass.prototype.update = function (renderer, camera, frame) {
    var width = renderer.getWidth();
    var height = renderer.getHeight();

    var ssaoPass = this._ssaoPass;
    var blurPass = this._blurPass;

    ssaoPass.setUniform('kernel', this._kernels[frame % this._kernels.length]);
    ssaoPass.setUniform('depthTex', this._depthTex);
    if (this._normalTex != null) {
        ssaoPass.setUniform('normalTex', this._normalTex);
    }
    ssaoPass.setUniform('depthTexSize', [this._depthTex.width, this._depthTex.height]);

    var viewInverseTranspose = new Matrix4();
    Matrix4.transpose(viewInverseTranspose, camera.worldTransform);

    ssaoPass.setUniform('projection', camera.projectionMatrix._array);
    ssaoPass.setUniform('projectionInv', camera.invProjectionMatrix._array);
    ssaoPass.setUniform('viewInverseTranspose', viewInverseTranspose._array);

    var ssaoTexture = this._ssaoTexture;
    var targetTexture = this._targetTexture;

    ssaoTexture.width = width;
    ssaoTexture.height = height;
    targetTexture.width = width;
    targetTexture.height = height;
    
    this._framebuffer.attach(ssaoTexture);
    this._framebuffer.bind(renderer);
    renderer.gl.clearColor(1, 1, 1, 1);
    renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT);
    ssaoPass.render(renderer);

    this._framebuffer.attach(targetTexture);
    blurPass.setUniform('textureSize', [width, height]);
    blurPass.setUniform('ssaoTexture', this._ssaoTexture);
    blurPass.render(renderer);

    this._framebuffer.unbind(renderer);

    // Restore clear
    var clearColor = renderer.clearColor;
    renderer.gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
};

SSAOPass.prototype.getTargetTexture = function () {
    return this._targetTexture;
}

SSAOPass.prototype.setParameter = function (name, val) {
    if (name === 'noiseTexSize') {
        this.setNoiseSize(val);
    }
    else if (name === 'kernelSize') {
        this.setKernelSize(val);
    }
    else if (name === 'blurSize') {
        this._blurPass.material.shader.define('fragment', 'BLUR_SIZE', val);
    }
    else if (name === 'intensity') {
        this._ssaoPass.material.set('intensity', val);
    }
    else {
        this._ssaoPass.setUniform(name, val);
    }
};

SSAOPass.prototype.setKernelSize = function (size) {
    this._kernelSize = size;
    this._ssaoPass.material.shader.define('fragment', 'KERNEL_SIZE', size);
    this._kernels = this._kernels || [];
    for (var i = 0; i < 30; i++) {
        this._kernels[i] = generateKernel(size, i * size, !!this._normalTex);
    }
};

SSAOPass.prototype.setNoiseSize = function (size) {
    var texture = this._ssaoPass.getUniform('noiseTex');
    if (!texture) {
        texture = generateNoiseTexture(size);
        this._ssaoPass.setUniform('noiseTex', generateNoiseTexture(size));
    }
    else {
        texture.data = generateNoiseData(size);
        texture.width = texture.height = size;
        texture.dirty();
    }

    this._ssaoPass.setUniform('noiseTexSize', [size, size]);
};

SSAOPass.prototype.dispose = function (gl) {
    this._targetTexture.dispose(gl);
    this._ssaoTexture.dispose(gl);
};

module.exports = SSAOPass;