export default /* glsl */`

// Direction (not normalized) of PMREM face coordinates (see getUV) that may lie past the face edge.
// The texel grid continues into the neighbouring face at the same texel index along the edge, so
// coordinates past the edge land on the neighbour's texel centers rather than on the extrapolated face plane.
vec3 cubeFaceDir( float face, vec2 uv ) {

	vec2 st = 2.0 * uv - 1.0;
	vec2 over = min( max( abs( st ) - 1.0, 0.0 ), 0.75 );
	st = clamp( st, - 1.0, 1.0 ) / ( ( 1.0 - over.x ) * ( 1.0 - over.y ) );

	if ( face == 0.0 ) return vec3( 1.0, st.y, st.x );
	if ( face == 1.0 ) return vec3( - st.x, 1.0, - st.y );
	if ( face == 2.0 ) return vec3( - st.x, st.y, 1.0 );
	if ( face == 3.0 ) return vec3( - 1.0, st.y, - st.x );
	if ( face == 4.0 ) return vec3( - st.x, - 1.0, st.y );
	return vec3( st.x, st.y, - 1.0 );

}
`;
