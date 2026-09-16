import { CubeReflectionMapping, CubeRefractionMapping, CubeUVReflectionMapping, EquirectangularReflectionMapping, EquirectangularRefractionMapping } from '../../constants.js';
import { PMREMGenerator } from '../../extras/PMREMGenerator.js';
import { CubemapBlurGenerator } from '../../extras/CubemapBlurGenerator.js';
import { WebGLCubeRenderTarget } from '../WebGLCubeRenderTarget.js';

function WebGLEnvironments( renderer ) {

	let cubeMaps = new WeakMap();
	let pmremMaps = new WeakMap();
	let blurMaps = new WeakMap();

	let pmremGenerator = null;
	let blurGenerator = null;

	function get( texture, usePMREM = false ) {

		if ( texture === null || texture === undefined ) return null;

		if ( usePMREM ) {

			return getPMREM( texture );

		}

		return getCube( texture );

	}

	function getCube( texture ) {

		if ( texture && texture.isTexture ) {

			const mapping = texture.mapping;

			if ( mapping === EquirectangularReflectionMapping || mapping === EquirectangularRefractionMapping ) {

				if ( cubeMaps.has( texture ) ) {

					const cubemap = cubeMaps.get( texture ).texture;
					return mapTextureMapping( cubemap, texture.mapping );

				} else {

					const image = texture.image;

					if ( image && image.height > 0 ) {

						const renderTarget = new WebGLCubeRenderTarget( image.height );
						renderTarget.fromEquirectangularTexture( renderer, texture );
						cubeMaps.set( texture, renderTarget );

						texture.addEventListener( 'dispose', onCubemapDispose );

						return mapTextureMapping( renderTarget.texture, texture.mapping );

					} else {

						// image not yet ready. try the conversion next frame

						return null;

					}

				}

			}

		}

		return texture;

	}

	function getPMREM( texture ) {

		if ( texture && texture.isTexture ) {

			const mapping = texture.mapping;

			const isEquirectMap = ( mapping === EquirectangularReflectionMapping || mapping === EquirectangularRefractionMapping );
			const isCubeMap = ( mapping === CubeReflectionMapping || mapping === CubeRefractionMapping );

			// equirect/cube map to cubeUV conversion

			if ( isEquirectMap || isCubeMap ) {

				let renderTarget = pmremMaps.get( texture );

				const currentPMREMVersion = renderTarget !== undefined ? renderTarget.texture.pmremVersion : 0;

				if ( texture.isRenderTargetTexture && texture.pmremVersion !== currentPMREMVersion ) {

					if ( pmremGenerator === null ) pmremGenerator = new PMREMGenerator( renderer );

					renderTarget = isEquirectMap ? pmremGenerator.fromEquirectangular( texture, renderTarget ) : pmremGenerator.fromCubemap( texture, renderTarget );
					renderTarget.texture.pmremVersion = texture.pmremVersion;

					pmremMaps.set( texture, renderTarget );

					return renderTarget.texture;

				} else {

					if ( renderTarget !== undefined ) {

						return renderTarget.texture;

					} else {

						const image = texture.image;

						if ( ( isEquirectMap && image && image.height > 0 ) || ( isCubeMap && image && isCubeTextureComplete( image ) ) ) {

							if ( pmremGenerator === null ) pmremGenerator = new PMREMGenerator( renderer );

							renderTarget = isEquirectMap ? pmremGenerator.fromEquirectangular( texture ) : pmremGenerator.fromCubemap( texture );
							renderTarget.texture.pmremVersion = texture.pmremVersion;

							pmremMaps.set( texture, renderTarget );

							texture.addEventListener( 'dispose', onPMREMDispose );

							return renderTarget.texture;

						} else {

							// image not yet ready. try the conversion next frame

							return null;

						}

					}

				}

			}

		}

		return texture;

	}

	// blurred cube map for Scene.backgroundBlurriness, see CubemapBlurGenerator

	function getBlurred( texture, blurriness ) {

		if ( texture && texture.isTexture ) {

			const mapping = texture.mapping;

			const isEquirectMap = ( mapping === EquirectangularReflectionMapping || mapping === EquirectangularRefractionMapping );
			const isCubeMap = ( mapping === CubeReflectionMapping || mapping === CubeRefractionMapping );

			if ( isEquirectMap || isCubeMap || mapping === CubeUVReflectionMapping ) {

				let entry = blurMaps.get( texture );

				if ( entry === undefined || entry.blurriness !== blurriness || entry.pmremVersion !== texture.pmremVersion ) {

					const image = texture.image;
					const ready = isCubeMap ? ( image && isCubeTextureComplete( image ) ) : ( image && image.height > 0 );

					if ( ! ready ) return null; // image not yet ready. try the conversion next frame

					if ( blurGenerator === null ) blurGenerator = new CubemapBlurGenerator( renderer );

					if ( entry === undefined ) {

						entry = { renderTarget: null };
						blurMaps.set( texture, entry );

						texture.addEventListener( 'dispose', onBlurDispose );

					}

					entry.renderTarget = blurGenerator.fromTexture( texture, blurriness, entry.renderTarget );
					entry.blurriness = blurriness;
					entry.pmremVersion = texture.pmremVersion;

				}

				return entry.renderTarget.texture;

			}

		}

		return texture;

	}

	function mapTextureMapping( texture, mapping ) {

		if ( mapping === EquirectangularReflectionMapping ) {

			texture.mapping = CubeReflectionMapping;

		} else if ( mapping === EquirectangularRefractionMapping ) {

			texture.mapping = CubeRefractionMapping;

		}

		return texture;

	}

	function isCubeTextureComplete( image ) {

		let count = 0;
		const length = 6;

		for ( let i = 0; i < length; i ++ ) {

			if ( image[ i ] !== undefined ) count ++;

		}

		return count === length;

	}

	function onCubemapDispose( event ) {

		const texture = event.target;

		texture.removeEventListener( 'dispose', onCubemapDispose );

		const cubemap = cubeMaps.get( texture );

		if ( cubemap !== undefined ) {

			cubeMaps.delete( texture );
			cubemap.dispose();

		}

	}

	function onPMREMDispose( event ) {

		const texture = event.target;

		texture.removeEventListener( 'dispose', onPMREMDispose );

		const pmrem = pmremMaps.get( texture );

		if ( pmrem !== undefined ) {

			pmremMaps.delete( texture );
			pmrem.dispose();

		}

	}

	function onBlurDispose( event ) {

		const texture = event.target;

		texture.removeEventListener( 'dispose', onBlurDispose );

		const entry = blurMaps.get( texture );

		if ( entry !== undefined ) {

			blurMaps.delete( texture );
			entry.renderTarget.dispose();

		}

	}

	function dispose() {

		cubeMaps = new WeakMap();
		pmremMaps = new WeakMap();
		blurMaps = new WeakMap();

		if ( pmremGenerator !== null ) {

			pmremGenerator.dispose();
			pmremGenerator = null;

		}

		if ( blurGenerator !== null ) {

			blurGenerator.dispose();
			blurGenerator = null;

		}

	}

	return {
		get: get,
		getBlurred: getBlurred,
		dispose: dispose
	};

}

export { WebGLEnvironments };
