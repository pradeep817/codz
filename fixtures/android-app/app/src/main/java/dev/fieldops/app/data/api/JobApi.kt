package dev.fieldops.app.data.api

import dev.fieldops.app.data.model.Job
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query

interface JobApi {
    /** All jobs, newest first. */
    @GET("jobs")
    suspend fun getJobs(@Query("page") page: Int? = null): List<Job>

    @GET("jobs/{id}")
    suspend fun getJob(@Path("id") id: Int): Job
}
